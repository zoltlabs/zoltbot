import { rmSync } from "node:fs";
import path from "node:path";
import {
  type CommandContext,
  type DomainState,
  decideWorkflowStep,
  finishTaskTurn,
  fireRoutine,
  handle,
  type Outcome,
  startTask,
} from "@zoltbot/core";
import type { PipelineVersion, Routine, WorkflowEdge, WorkflowRun } from "@zoltbot/protocol";
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
  let now = at;
  let stopped: string[] = [];
  const run = (
    commandId: string,
    actor: CommandContext["actor"],
    work: (state: DomainState, context: CommandContext) => Outcome,
  ) => store.dispatch(commandId, (state) => work(state, { commandId, at: now, actor })).result;
  const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
  const system = { kind: "system", id: "runtime" } as const;
  const runner = () =>
    workflowRunner({
      store,
      run,
      now: () => now,
      stop: async (taskId) => {
        stopped.push(taskId);
      },
      checkPublic: async () => () => {},
      onError: (code) => code,
    });
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
    now = at;
    stopped = [];
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
    await publish(workflow);
  });
  async function publish(value: PipelineVersion) {
    const api = workflowsApi({ store, publish: () => {}, checkPublic: async () => () => {} });
    return (await api(
      "workflow.publish",
      { value, confirmed: true },
      `publish:${++serial}`,
    )) as PipelineVersion;
  }
  /** A second workflow: a trigger feeding the given steps, all in parallel. */
  function other(
    nodes: NonNullable<PipelineVersion["graph"]>["nodes"],
    extra: Partial<PipelineVersion> = {},
  ) {
    return {
      ...workflow,
      workflowId: "other",
      ...extra,
      graph: {
        nodes: [
          {
            id: "start",
            kind: "trigger" as const,
            name: "By hand",
            trigger: { type: "manual" as const },
          },
          ...nodes,
        ],
        edges: nodes.map((node): WorkflowEdge => ({ from: "start", to: node.id, carry: "none" })),
      },
    } satisfies PipelineVersion;
  }
  const otherStep = (runId: string, id: string) =>
    record(runId).steps?.find((entry) => entry.id === id);
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

  it("ends a timed wait on a later tick, and fails the run when a step's task fails", async () => {
    const workflows = runner();
    await workflows.start(workflow, {}, "r1");
    finishTask("run:r1:read", "Nothing much.");
    workflows.observe(store.eventsSince(0));
    expect(step("quiet")).toMatchObject({ state: "running", startedAt: at });
    expect(step("write")).toMatchObject({ state: "skipped" });
    // A quiet tick before the wait ends writes nothing at all.
    now = later(4);
    const seq = store.lastSeq();
    workflows.tick();
    expect(store.lastSeq()).toBe(seq);
    now = later(5);
    workflows.tick();
    expect(step("quiet")).toMatchObject({ state: "done" });
    expect(record("run:r1").state).toBe("completed");

    await workflows.start(workflow, {}, "r3");
    run(`start:${++serial}`, system, (s, c) => startTask(s, "run:r3:read", 1, c));
    run(`finish:${++serial}`, system, (s, c) =>
      finishTaskTurn(s, "run:r3:read", 1, { status: "failed", text: "" }, c),
    );
    workflows.observe(store.eventsSince(0));
    expect(record("run:r3")).toMatchObject({ state: "failed", reason: "workflow_step_failed" });
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

  it("waits for the owner's approval, then continues or stops", async () => {
    const value = other([
      { id: "ok", kind: "wait", name: "Check with me", until: { type: "approval" } },
      {
        id: "next",
        kind: "agent",
        name: "Next",
        profileId: "profile",
        brief: "Go on.",
        gate: "human",
      },
    ]);
    value.graph.edges = [
      { from: "start", to: "ok", carry: "none" },
      { from: "ok", to: "next", carry: "none" },
    ];
    await publish(value);
    const workflows = runner();
    await workflows.start(value, {}, "a1");
    expect(record("run:a1").state).toBe("at_gate");
    expect(otherStep("run:a1", "ok")).toMatchObject({ state: "needs_you" });
    expect(() =>
      run("forged", system, (s, c) =>
        decideWorkflowStep(s, { runId: "run:a1", stepId: "ok", decision: "continue" }, c),
      ),
    ).toThrow("human_decision_required");
    workflows.control(
      "workflow.decide",
      { id: "run:a1", stepId: "ok", decision: "continue" },
      "d1",
    );
    expect(otherStep("run:a1", "next")).toMatchObject({ state: "running" });
    // Answering twice is refused.
    expect(() =>
      workflows.control("workflow.decide", { id: "run:a1", stepId: "ok", decision: "stop" }, "d2"),
    ).toThrow("workflow_step_not_waiting");

    // a1 is still running, and overlap is "skip".
    await expect(workflows.start(value, {}, "a2")).rejects.toThrow("workflow_already_running");
  });

  it("stops a run at the owner's word, cancelling its other steps' tasks", async () => {
    const value = other([
      { id: "ok", kind: "wait", name: "Check with me", until: { type: "approval" } },
      {
        id: "side",
        kind: "agent",
        name: "Side",
        profileId: "profile",
        brief: "Look around.",
        gate: "human",
      },
    ]);
    await publish(value);
    const workflows = runner();
    await workflows.start(value, {}, "s1");
    run(`start:${++serial}`, system, (s, c) => startTask(s, "run:s1:side", 1, c));
    workflows.control("workflow.decide", { id: "run:s1", stepId: "ok", decision: "stop" }, "d1");
    expect(record("run:s1")).toMatchObject({ state: "cancelled", reason: "workflow_stopped" });
    expect(store.record("task", "run:s1:side")).toMatchObject({ state: "cancelled" });
    expect(stopped).toEqual(["run:s1:side"]);
  });

  it("stops the other steps' tasks when one step fails", async () => {
    const value = other([
      { id: "a", kind: "agent", name: "A", profileId: "profile", brief: "Try A.", gate: "human" },
      { id: "b", kind: "agent", name: "B", profileId: "profile", brief: "Try B.", gate: "human" },
    ]);
    await publish(value);
    const workflows = runner();
    await workflows.start(value, {}, "f1");
    run(`start:${++serial}`, system, (s, c) => startTask(s, "run:f1:a", 1, c));
    run(`finish:${++serial}`, system, (s, c) =>
      finishTaskTurn(s, "run:f1:a", 1, { status: "failed", text: "" }, c),
    );
    workflows.observe(store.eventsSince(0));
    expect(record("run:f1").state).toBe("failed");
    expect(store.record("task", "run:f1:b")).toMatchObject({ state: "cancelled" });
    expect(stopped).toEqual(["run:f1:b"]);
  });

  it("starts no step that would take the run past its total budget", async () => {
    const value = other(
      [
        {
          id: "a",
          kind: "agent",
          name: "A",
          profileId: "profile",
          brief: "Try A.",
          gate: "human",
          budgetUsd: 0.4,
        },
        {
          id: "b",
          kind: "agent",
          name: "B",
          profileId: "profile",
          brief: "Try B.",
          gate: "human",
          budgetUsd: 0.4,
        },
      ],
      { budget: { usd: 0.5 } },
    );
    await publish(value);
    // Without a step budget the total can't be kept, so publishing refuses.
    const open = other(
      [{ id: "a", kind: "agent", name: "A", profileId: "profile", brief: "Try A.", gate: "human" }],
      { budget: { usd: 0.5 } },
    );
    await expect(publish(open)).rejects.toThrow("workflow_step_budget_required: a");
    const workflows = runner();
    await workflows.start(value, {}, "b1");
    expect(record("run:b1")).toMatchObject({ state: "failed", reason: "workflow_budget_reached" });
    expect(store.record("task", "run:b1:a")).toMatchObject({ state: "cancelled" });
    expect(store.record("task", "run:b1:b")).toBeUndefined();
  });

  it("starts no new steps while the workflow is paused", async () => {
    const workflows = runner();
    await workflows.start(workflow, {}, "r1");
    workflows.control("workflow.pause", { id: "news" }, "p1");
    finishTask("run:r1:read", "A big story.");
    workflows.observe(store.eventsSince(0));
    expect(step("read")).toMatchObject({ state: "done" });
    expect(step("write")).toMatchObject({ state: "waiting" });
    workflows.control("workflow.resume", { id: "news" }, "p2");
    expect(step("write")).toMatchObject({ state: "running" });
  });

  it("gives media and connection steps their own briefs, always reviewed", async () => {
    const value = other([
      {
        id: "pic",
        kind: "media",
        name: "Picture",
        profileId: "profile",
        brief: "Draw the harbour.",
        output: "image",
      },
      {
        id: "post",
        kind: "connection",
        name: "Post it",
        connectionId: "chat-app",
        action: "Post a message",
        input: { channel: "news" },
      },
    ]);
    await publish(value);
    // No earlier step's text may reach a connection step.
    const fed = structuredClone(value);
    fed.graph.edges.push({ from: "pic", to: "post", carry: "summary" });
    await expect(publish(fed)).rejects.toThrow("workflow_connection_carry: post");
    await runner().start(value, {}, "m1");
    expect(store.record("task", "run:m1:pic")).toMatchObject({
      reviewRequired: true,
      brief:
        "Draw the harbour.\n\nMake one image file for this, and name the file in your summary.",
    });
    const post = store.record("task", "run:m1:post");
    expect(post).toMatchObject({ reviewRequired: true, ownerAgentId: "profile" });
    expect(String(post?.brief)).toContain(
      'Use the "chat-app" connection to do exactly one thing: Post a message',
    );
    expect(String(post?.brief)).toContain('Input (JSON): {"channel":"news"}');
  });

  it("runs a scheduled workflow through its own routine", async () => {
    const scheduled = {
      ...workflow,
      workflowId: "daily",
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.kind === "trigger"
            ? {
                ...node,
                trigger: { type: "schedule" as const, cron: "0 9 * * *", timezone: "UTC" },
              }
            : node,
        ),
      },
    };
    await publish(scheduled);
    const routine = store.record("routine", "workflow-routine:daily") as unknown as Routine;
    expect(routine).toMatchObject({ workflowId: "daily", paused: false, name: "Morning news" });
    expect(routine.nextRunAt > at).toBe(true);

    // The routine fires: a run starts instead of a task, and the occurrence records it.
    const fire = (id: string, scheduledAt: string, manual = false) =>
      run(id, system, (s, c) => {
        const current = s.routine?.find((row) => row.id === routine.id) as unknown as Routine;
        return fireRoutine(s, current, scheduledAt, "fire", c, manual);
      });
    fire("fire-1", routine.nextRunAt);
    const first = `run:${routine.id}@${routine.nextRunAt}`;
    expect(record(first)).toMatchObject({
      workflowId: "daily",
      trigger: "schedule",
      state: "running",
    });
    expect(store.record("routineOccurrence", `${routine.id}@${routine.nextRunAt}`)).toMatchObject({
      status: "completed",
    });
    // Run now while that run is going is skipped, not doubled.
    fire("fire-2", later(1), true);
    expect(store.record("routineOccurrence", `${routine.id}@${later(1)}:manual`)).toMatchObject({
      status: "skipped",
      reason: "Previous run is still going",
    });

    // Pausing the workflow pauses its routine, and the routine can't be edited on its own.
    runner().control("workflow.pause", { id: "daily" }, "pause");
    expect(store.record("routine", routine.id)).toMatchObject({ paused: true });
    // Run now while paused starts nothing.
    fire("fire-3", later(2), true);
    expect(store.record("routineOccurrence", `${routine.id}@${later(2)}:manual`)).toMatchObject({
      status: "skipped",
      reason: "Workflow is paused",
    });
    // A version run by hand retires the old routine for good, keeping its history.
    await publish({ ...scheduled, graph });
    expect(store.record("routine", routine.id)).toMatchObject({
      paused: true,
      workflowId: "daily",
    });
    expect(store.record("routine", routine.id)?.doneAt).toBeDefined();
    runner().control("workflow.resume", { id: "daily" }, "resume");
    fire("fire-4", later(3), true);
    expect(store.record("routineOccurrence", `${routine.id}@${later(3)}:manual`)).toMatchObject({
      status: "skipped",
      reason: "Workflow no longer runs on a schedule",
    });
    // Event and message triggers aren't available yet.
    const evented: PipelineVersion = structuredClone(scheduled);
    evented.graph?.nodes.splice(0, 1, {
      id: "start",
      kind: "trigger",
      name: "Message",
      trigger: { type: "message", bridgeId: "bridge" },
    });
    await expect(publish(evented)).rejects.toThrow("workflow_trigger_unavailable: message");
  });
});
