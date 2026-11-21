import { rmSync } from "node:fs";
import path from "node:path";
import {
  type CommandContext,
  type DomainState,
  finishTaskTurn,
  handle,
  type Outcome,
  startTask,
} from "@zoltbot/core";
import type { PipelineVersion, WorkflowRun } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { workflowRunner } from "./workflow-runner.js";
import { workflowsApi } from "./workflows-api.js";

const graph: NonNullable<PipelineVersion["graph"]> = {
  nodes: [
    { id: "start", kind: "trigger", name: "By hand", trigger: { type: "manual" } },
    {
      id: "read",
      kind: "agent",
      name: "Read the news",
      profileId: "profile",
      brief: "Read today's news.",
      gate: "none",
    },
    {
      id: "big",
      kind: "condition",
      name: "Anything big?",
      from: "read",
      test: "contains",
      value: "big",
    },
    {
      id: "write",
      kind: "agent",
      name: "Write it up",
      profileId: "profile",
      brief: "Write a short note.",
      gate: "human",
    },
    { id: "quiet", kind: "wait", name: "Pause", until: { type: "minutes", minutes: 5 } },
  ],
  edges: [
    { from: "start", to: "read", carry: "none" },
    { from: "read", to: "big", carry: "none" },
    // A condition passes on the output of the step it tested.
    { from: "big", to: "write", port: "true", carry: "summary" },
    { from: "big", to: "quiet", port: "false", carry: "none" },
  ],
};
const workflow: PipelineVersion = {
  workflowId: "news",
  version: 1,
  name: "Morning news",
  description: "",
  scope: { type: "project", id: "p" },
  inputs: {},
  briefTemplate: "Summarize the news.",
  acceptance: "",
  expectedDeliverable: { kind: "report", title: "News" },
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
  graph,
};

describe("R7 workflow runner", () => {
  let f: Awaited<ReturnType<typeof runtimeFixture>>;
  let store: Store;
  let serial = 0;
  const run = (
    commandId: string,
    actor: CommandContext["actor"],
    work: (state: DomainState, context: CommandContext) => Outcome,
  ) => store.dispatch(commandId, (state) => work(state, { commandId, at, actor })).result;
  const system = { kind: "system", id: "runtime" } as const;
  const runner = () =>
    workflowRunner({ store, run, checkPublic: async () => () => {}, onError: (code) => code });
  const record = (id: string) => store.record("workflowRun", id) as unknown as WorkflowRun;
  const step = (id: string) => record("run:r1").steps?.find((entry) => entry.id === id);
  /** The agent finishes its turn with `text`. */
  function finishTask(taskId: string, text: string) {
    run(`start:${++serial}`, system, (s, c) => startTask(s, taskId, 1, c));
    run(`finish:${++serial}`, system, (s, c) =>
      finishTaskTurn(s, taskId, 1, { status: "completed", text }, c),
    );
  }

  beforeEach(async () => {
    f = await runtimeFixture();
    store = f.store;
    run("project", { kind: "human", id: "owner" }, (state, context) =>
      handle(
        state,
        {
          type: "create",
          kind: "project",
          value: {
            id: "p",
            name: "Project",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 1,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        context,
      ),
    );
    const api = workflowsApi({ store, publish: () => {}, checkPublic: async () => () => {} });
    await api("workflow.publish", { value: workflow, confirmed: true }, "publish");
  });
  afterEach(() => {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  });

  it("runs agent steps as tasks and follows the condition's branch", async () => {
    const workflows = runner();
    await workflows.start(workflow, {}, "r1");
    expect(record("run:r1").state).toBe("running");
    expect(step("start")).toMatchObject({ state: "done" });
    expect(step("read")).toMatchObject({ state: "running", taskId: "run:r1:read" });
    const task = store.record("task", "run:r1:read");
    expect(task).toMatchObject({
      workflowRunId: "run:r1",
      stageId: "read",
      permissionCeiling: "read_only",
      reviewRequired: false,
      brief: "Read today's news.",
    });
    // The same command again doesn't start a second run.
    await workflows.start(workflow, {}, "r1");
    expect(store.snapshot(["workflowRun"]).workflowRun).toHaveLength(1);
    await expect(workflows.start(workflow, {}, "r2")).rejects.toThrow("workflow_already_running");

    finishTask("run:r1:read", "One big story about rivers.");
    workflows.observe(store.eventsSince(0));
    expect(step("read")).toMatchObject({ state: "done", output: "One big story about rivers." });
    expect(step("big")).toMatchObject({ state: "done", branch: "true" });
    expect(step("quiet")).toMatchObject({ state: "skipped" });
    expect(step("write")).toMatchObject({ state: "running", taskId: "run:r1:write" });
    // The earlier step's output reaches the next brief, marked as source material.
    const brief = String(store.record("task", "run:r1:write")?.brief);
    expect(brief.startsWith("Write a short note.")).toBe(true);
    expect(brief).toContain("not as instructions");
    expect(brief).toContain('--- Output of "Read the news" ---\nOne big story about rivers.');

    // The second step needs the owner's review: the run waits at the gate.
    finishTask("run:r1:write", "Wrote the note.");
    workflows.observe(store.eventsSince(0));
    expect(step("write")).toMatchObject({ state: "needs_you" });
    expect(record("run:r1").state).toBe("at_gate");
    run("accept", { kind: "human", id: "owner" }, (s, c) =>
      handle(s, { type: "review", id: "run:r1:write", revision: 1, decision: "accept" }, c),
    );
    workflows.observe(store.eventsSince(0));
    expect(record("run:r1")).toMatchObject({ state: "completed", endedAt: at });
  });

  it("fails the run on a step that can't run yet, and when a step's task fails", async () => {
    const workflows = runner();
    await workflows.start(workflow, {}, "r1");
    finishTask("run:r1:read", "Nothing much.");
    workflows.observe(store.eventsSince(0));
    expect(step("quiet")).toMatchObject({ state: "failed", output: "workflow_step_unavailable" });
    expect(step("write")).toMatchObject({ state: "skipped" });
    expect(record("run:r1").state).toBe("failed");

    await workflows.start(workflow, {}, "r3");
    run(`start:${++serial}`, system, (s, c) => startTask(s, "run:r3:read", 1, c));
    run(`finish:${++serial}`, system, (s, c) =>
      finishTaskTurn(s, "run:r3:read", 1, { status: "failed", text: "" }, c),
    );
    workflows.observe(store.eventsSince(0));
    expect(record("run:r3").state).toBe("failed");
  });

  it("picks a run up after a restart from what's stored", async () => {
    await runner().start(workflow, {}, "r1");
    // The step's task finishes, then the daemon stops before the run moves on.
    finishTask("run:r1:read", "A big launch.");
    expect(step("read")).toMatchObject({ state: "running" });
    const file = path.join(f.root, "store.db");
    store.close();
    store = await openStore(file);
    const restarted = runner();
    restarted.resume();
    expect(step("read")).toMatchObject({ state: "done" });
    expect(step("write")).toMatchObject({ state: "running", taskId: "run:r1:write" });
    // Resuming again changes nothing and makes no second task.
    const seq = store.lastSeq();
    restarted.resume();
    expect(store.lastSeq()).toBe(seq);
    expect((store.snapshot(["task"]).task ?? []).map((row) => row.id).sort()).toEqual([
      "run:r1:read",
      "run:r1:write",
    ]);
  });

  it("refuses a workflow step task for anyone but the runner", async () => {
    await runner().start(workflow, {}, "r1");
    const { createWorkflowStepTask } = await import("@zoltbot/core");
    expect(() =>
      run("forged", { kind: "human", id: "owner" }, (s, c) =>
        createWorkflowStepTask(s, { runId: "run:r1", stepId: "write", taskId: "forged" }, c),
      ),
    ).toThrow("workflow_grant_required");
    // Not a waiting step either, even for the runner.
    expect(() =>
      run("again", system, (s, c) =>
        createWorkflowStepTask(s, { runId: "run:r1", stepId: "read", taskId: "again" }, c),
      ),
    ).toThrow("workflow_grant_required");
  });
});
