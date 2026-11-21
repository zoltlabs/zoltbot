import type { PipelineVersion, WorkflowRun } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import {
  awaitsApproval,
  latestWorkflows,
  readRuns,
  readWorkflows,
  runSteps,
  workflowError,
  workflowLine,
  workflowPaused,
  workflowRuns,
} from "./workflows";

const workflow = {
  workflowId: "digest",
  version: 1,
  name: "Morning digest",
  description: "",
  scope: { type: "project", id: "p" },
  inputs: {},
  briefTemplate: "Write the digest.",
  acceptance: "",
  expectedDeliverable: { kind: "report", title: "Digest" },
  checks: [],
  permissionProfile: "read_only",
  executorAgent: "profile",
  workspaceMode: "shared",
  budget: {},
  retry: { maxAttempts: 1, backoffSeconds: [], retryOn: [] },
  review: "required",
  notify: "on_change",
  trigger: [{ kind: "manual" }],
  overlap: "skip",
  previousResult: "none",
  stages: [],
  loops: [],
  graph: {
    nodes: [
      {
        id: "write",
        kind: "agent",
        name: "Write",
        profileId: "profile",
        brief: "Write.",
        gate: "human",
      },
      { id: "start", kind: "trigger", name: "By hand", trigger: { type: "manual" } },
      { id: "ok", kind: "wait", name: "Check with me", until: { type: "approval" } },
    ],
    edges: [
      { from: "start", to: "ok", carry: "none" },
      { from: "ok", to: "write", carry: "none" },
    ],
  },
} satisfies PipelineVersion;
const run: WorkflowRun = {
  id: "run:1",
  workflowId: "digest",
  version: 1,
  trigger: "manual",
  inputs: {},
  state: "at_gate",
  steps: [
    { id: "start", state: "done" },
    { id: "ok", state: "needs_you" },
    { id: "write", state: "waiting" },
  ],
};

describe("R7 workflows on the phone", () => {
  it("lists steps in graph order with this run's states", () => {
    const steps = runSteps(workflow, run);
    expect(steps.map((entry) => [entry.node.id, entry.state?.state])).toEqual([
      ["start", "done"],
      ["ok", "needs_you"],
      ["write", "waiting"],
    ]);
    const [, wait, write] = steps;
    expect(wait && awaitsApproval(wait.node, wait.state)).toBe(true);
    expect(write && awaitsApproval(write.node, write.state)).toBe(false);
  });

  it("drops rows that don't match the protocol", () => {
    expect(readWorkflows({ items: [workflow, { workflowId: 3 }] })).toHaveLength(1);
    expect(readRuns({ items: [run, { id: "x" }] })).toHaveLength(1);
    expect(readRuns(undefined)).toEqual([]);
  });

  it("says whether a workflow is paused and how its newest run went", () => {
    const settings = [{ key: "workflow.paused.digest", value: true }];
    expect(workflowPaused(settings, "digest")).toBe(true);
    expect(workflowPaused(settings, "other")).toBe(false);
    expect(workflowLine(true, run)).toBe("Paused");
    expect(workflowLine(false, run)).toBe("Needs you");
    expect(workflowLine(false, undefined)).toBe("Not run yet");
    expect(workflowError(new Error("workflow_already_running"))).toBe(
      "This workflow is already running.",
    );
  });

  it("reads the newest version and a workflow's runs from the snapshot, newest first", () => {
    const older = { ...workflow, name: "Old" };
    expect(
      latestWorkflows([older, { ...workflow, version: 2 }]).map((entry) => entry.name),
    ).toEqual(["Morning digest"]);
    const later = { ...run, id: "run:2", startedAt: "2026-02-02T00:00:00.000Z" };
    const earlier = { ...run, startedAt: "2026-01-01T00:00:00.000Z" };
    expect(workflowRuns([earlier, later], "digest").map((entry) => entry.id)).toEqual([
      "run:2",
      "run:1",
    ]);
    expect(workflowRuns([earlier], "other")).toEqual([]);
  });
});
