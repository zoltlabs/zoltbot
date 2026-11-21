import type { PipelineVersion } from "@zoltbot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { workflowsApi } from "./workflows-api.js";

function workflow(graph: PipelineVersion["graph"]): PipelineVersion {
  return {
    workflowId: "news",
    version: 1,
    name: "Morning news",
    description: "",
    scope: { type: "user", id: "local-owner" },
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
    ...(graph ? { graph } : {}),
  };
}

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
      budgetUsd: 0.5,
    },
    {
      id: "any",
      kind: "condition",
      name: "Anything big?",
      from: "read",
      test: "contains",
      value: "big",
    },
    { id: "wait", kind: "wait", name: "Ask me", until: { type: "approval" } },
    { id: "done", kind: "wait", name: "Pause", until: { type: "minutes", minutes: 5 } },
  ],
  edges: [
    { from: "start", to: "read", carry: "none" },
    { from: "read", to: "any", carry: "summary" },
    { from: "any", to: "wait", port: "true", carry: "summary" },
    { from: "any", to: "done", port: "false", carry: "none" },
  ],
};

describe("R7 workflows API", () => {
  let f: Awaited<ReturnType<typeof runtimeFixture>>;
  let api: ReturnType<typeof workflowsApi>;
  beforeEach(async () => {
    f = await runtimeFixture();
    api = workflowsApi({
      store: f.store,
      publish: () => {},
      checkPublic: async () => () => {},
      now: () => "2026-11-21T10:00:00.000Z",
    });
  });
  afterEach(() => f.close());

  it("publishes immutable versions and lists the newest", async () => {
    const first = (await api(
      "workflow.publish",
      { value: workflow(graph), confirmed: true },
      "p1",
    )) as PipelineVersion;
    expect(first.version).toBe(1);
    // The same command again returns its receipt instead of a third version.
    expect(
      await api("workflow.publish", { value: workflow(graph), confirmed: true }, "p1"),
    ).toEqual(first);
    const second = (await api(
      "workflow.publish",
      { value: { ...workflow(graph), name: "Morning news, short" }, confirmed: true },
      "p2",
    )) as PipelineVersion;
    expect(second.version).toBe(2);
    expect(await api("workflow.list", {})).toMatchObject({
      items: [{ workflowId: "news", version: 2, name: "Morning news, short" }],
    });
  });

  it("refuses an unconfirmed publish, a broken graph and an unknown agent", async () => {
    await expect(
      api("workflow.publish", { value: workflow(graph), confirmed: false }, "x1"),
    ).rejects.toThrow("confirmation_required");
    const cyclic = structuredClone(graph);
    cyclic.edges.push({ from: "wait", to: "read", carry: "none" });
    await expect(
      api("workflow.publish", { value: workflow(cyclic), confirmed: true }, "x2"),
    ).rejects.toThrow("workflow_graph_invalid: cycle");
    const stranger = structuredClone(graph);
    const step = stranger.nodes[1];
    if (step?.kind === "agent") step.profileId = "nobody";
    await expect(
      api("workflow.publish", { value: workflow(stranger), confirmed: true }, "x3"),
    ).rejects.toThrow("profile_unavailable: read");
    // A writing step fed by another step's output can't skip review.
    const unchecked = structuredClone(graph);
    unchecked.nodes.push({
      id: "act",
      kind: "agent",
      name: "Act on it",
      profileId: "profile",
      brief: "Do what the news says.",
      gate: "none",
    });
    unchecked.edges.push({ from: "read", to: "act", carry: "summary" });
    await expect(
      api(
        "workflow.publish",
        {
          value: { ...workflow(unchecked), permissionProfile: "workspace_write" },
          confirmed: true,
        },
        "x4",
      ),
    ).rejects.toThrow("workflow_review_required: act");
    expect(await api("workflow.list", {})).toEqual({ items: [] });
  });

  it("dry-runs a graph without starting anything", async () => {
    await api("workflow.publish", { value: workflow(graph), confirmed: true }, "p1");
    const run = (await api("workflow.run", { id: "news", inputs: {}, dryRun: true })) as {
      steps: { id: string; state: string; costCeilingUsd?: number }[];
    };
    expect(run.steps.map((step) => step.id)).toEqual(["start", "read", "any", "wait", "done"]);
    expect(run.steps[1]).toEqual({ id: "read", state: "would_run", costCeilingUsd: 0.5 });
    expect(await api("workflow.runs", {})).toEqual({ items: [] });
    expect(f.store.snapshot(["task"]).task ?? []).toHaveLength(0);
    await expect(api("workflow.run", { id: "news", inputs: {} }, "r1")).rejects.toThrow(
      "workflow_runner_unavailable",
    );
  });
});
