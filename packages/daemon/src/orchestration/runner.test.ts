import { handle } from "@zoltbot/core";
import { OrchestrationSchema, parse, parseEvent, TaskSchema } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "../private-input.js";
import { orchestrationRunner, phaseVerdict, testEvidence } from "./runner.js";

it("does not treat an ordinary completed response or ambiguous markers as a passed phase", () => {
  expect(phaseVerdict("Done")).toBe("blocked");
  expect(phaseVerdict("Failed [ZOLTBOT_PHASE:blocked]\n[ZOLTBOT_PHASE:passed]")).toBe("blocked");
});
it("persists sequential tasks, preserves a workspace, and sends review feedback through a repair round", async () => {
  const f = await runtimeFixture();
  const ctx = (commandId: string) => ({
    commandId,
    at,
    actor: { kind: "human" as const, id: "owner" },
  });
  const put = (kind: string, value: Record<string, unknown>, commandId: string) => {
    f.store.dispatch(commandId, () => ({
      events: [
        parseEvent({
          eventId: commandId,
          commandId,
          aggregateType: kind,
          aggregateId: String(value.id),
          type: `${kind}.updated`,
          occurredAt: at,
          payload: value,
        }),
      ],
      result: {},
    }));
  };
  f.store.dispatch("project", (state) =>
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
          hierarchyDepth: 3,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      },
      ctx("project"),
    ),
  );
  put(
    "thread",
    { ...f.store.record("thread", "thread"), projectId: "p", node: { type: "project", id: "p" } },
    "thread-project",
  );
  put(
    "agent",
    { ...f.store.record("agent", "profile"), permissionProfile: "workspace_write" },
    "writer",
  );
  put(
    "workspace",
    {
      id: "workspace",
      projectId: "p",
      kind: "worktree",
      path: f.root,
      state: "active",
      createdAt: at,
    },
    "workspace",
  );
  const run = parse(OrchestrationSchema, {
    id: "run",
    threadId: "thread",
    projectId: "p",
    brief: "Build feature",
    state: "running",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    phases: ["plan", "implement", "review", "tests"].map((role) => ({
      role,
      instruction: role,
      profileId: "profile",
      execution: {
        definitionId: "fake",
        model: "model",
        permissionCeiling: role === "plan" || role === "review" ? "read_only" : "workspace_write",
      },
      status: "pending",
      attempt: 1,
    })),
  });
  put("orchestration", run, "run");
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const makeRunner = () =>
    orchestrationRunner({
      store: f.store,
      privacy,
      publish() {},
      async schedule() {},
      async cancel() {},
      async prepare(id) {
        const task = parse(TaskSchema, f.store.record("task", id));
        if (!task.workspaceId) put("task", { ...task, workspaceId: "workspace" }, `prepare:${id}`);
      },
    });
  let runner = makeRunner();
  const latest = () => parse(OrchestrationSchema, f.store.record("orchestration", "run"));
  let serial = 0;
  async function finish(index: number, summary: string) {
    const phase = latest().phases[index];
    if (!phase?.taskId) throw Error("phase_not_started");
    const task = parse(TaskSchema, f.store.record("task", phase.taskId));
    put("task", { ...task, state: "review" }, `finish:${serial++}`);
    const commandId = `result:${serial++}`;
    f.store.dispatch(commandId, () => ({
      result: {},
      events: [
        parseEvent({
          eventId: commandId,
          commandId,
          aggregateType: "taskResult",
          aggregateId: `${task.id}:1`,
          type: "taskResult.updated",
          occurredAt: at,
          payload: {
            taskId: task.id,
            revision: 1,
            status: "done",
            summary,
            files: [],
            digest: "",
            auto: true,
            createdAt: at,
          },
        }),
      ],
    }));
    await runner.reconcile();
  }
  try {
    await runner.reconcile();
    expect(latest().phases[0]?.status).toBe("running");
    expect(f.store.snapshot(["task"]).task).toHaveLength(1);
    await runner.reconcile();
    expect(f.store.snapshot(["task"]).task).toHaveLength(1);
    await finish(0, "Plan ready [ZOLTBOT_PHASE:passed]");
    expect(latest().phases[1]?.status).toBe("running");
    await runner.close();
    runner = makeRunner();
    await runner.reconcile();
    expect(f.store.snapshot(["task"]).task).toHaveLength(2);
    await finish(1, "Implementation done [ZOLTBOT_PHASE:passed]");
    await finish(2, "SQL injection remains [ZOLTBOT_PHASE:blocked]");
    expect(latest().state).toBe("blocked");
    const repairRevision = latest().revision;
    await runner.action("orchestration.repair", "run", repairRevision, "repair");
    await runner.action("orchestration.repair", "run", repairRevision, "repair");
    await runner.reconcile();
    const implementation = latest().phases[1];
    expect(implementation?.attempt).toBe(2);
    expect(f.store.record("task", String(implementation?.taskId))?.brief).toContain(
      "CURRENT ATTEMPT: repair",
    );
    expect(f.store.record("task", String(implementation?.taskId))?.brief).toContain(
      "SQL injection",
    );
    expect(latest().workspaceId).toBe("workspace");
    await finish(1, "Fixed [ZOLTBOT_PHASE:passed]");
    await finish(2, "No open findings [ZOLTBOT_PHASE:passed]");
    const testTaskId = latest().phases[3]?.taskId;
    const testThreadId = f.store.record("task", String(testTaskId))?.threadId;
    put(
      "item",
      {
        id: "test-evidence",
        threadId: testThreadId,
        seq: 1,
        kind: "tool",
        body: {
          kind: "execute",
          input: { command: "pnpm test" },
          status: "ok",
          output: "All tests passed",
        },
        createdAt: at,
        updatedAt: at,
      },
      "evidence",
    );
    await finish(3, "Tests passed [ZOLTBOT_PHASE:passed]");
    expect(latest().state).toBe("completed");
    await expect(
      runner.action("orchestration.cancel", "run", latest().revision, "cancel-completed"),
    ).rejects.toThrow("active_run_required");
  } finally {
    await runner.close();
    f.close();
  }
});

it("accepts successful privacy-redacted test metadata without accepting arbitrary shell output", () => {
  const item = {
    threadId: "phase",
    kind: "tool",
    body: {
      kind: "execute",
      check: "tests",
      input: "[private tool input omitted]",
      output: "[private tool output omitted]",
      status: "ok",
    },
  };
  expect(testEvidence({ item: [item] }, "phase")).toBe(true);
  expect(
    testEvidence({ item: [{ ...item, body: { ...item.body, status: "error" } }] }, "phase"),
  ).toBe(false);
});

it("uses the latest test command by sequence rather than snapshot id order", () => {
  const body = { kind: "execute", check: "tests", output: "omitted", status: "ok" };
  const later = { id: "a", seq: 2, threadId: "phase", kind: "tool", body };
  const earlier = {
    id: "z",
    seq: 1,
    threadId: "phase",
    kind: "tool",
    body: { ...body, status: "error" },
  };
  expect(testEvidence({ item: [later, earlier] }, "phase")).toBe(true);
  expect(
    testEvidence(
      {
        item: [
          { ...later, body: { ...body, status: "error" } },
          { ...earlier, body },
        ],
      },
      "phase",
    ),
  ).toBe(false);
});
