import {
  type CommandContext,
  createTask,
  type DomainState,
  finishTaskTurn,
  fireRoutine,
  handle,
  type Outcome,
  ROUTINE_FOLDER_WAIT_MS,
  ROUTINE_PERMISSION_TIMEOUT_MS,
  requestInteraction,
  routineFromTask,
  startTask,
} from "@zoltbot/core";
import type { Routine } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { NotificationPlanner } from "./notifications.js";
import { recover } from "./recovery.js";
import { taskRunner } from "./task-runner.js";

const initial = "2026-11-04T00:00:00.000Z";
async function fixture(folder = false, browser = false) {
  const f = await runtimeFixture();
  let now = initial,
    serial = 0;
  const run = (
    work: (state: DomainState, context: CommandContext) => Outcome,
    id = `c${++serial}`,
  ) =>
    f.store.dispatch(id, (state) =>
      work(state, { commandId: id, at: now, actor: { kind: "human", id: "owner" } }),
    ).result;
  run((state, ctx) =>
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
          roots: folder ? [{ path: f.root, label: "code" }] : [],
          hierarchyDepth: 1,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: now,
        },
      },
      ctx,
    ),
  );
  if (browser)
    run((state, ctx) =>
      handle(
        state,
        {
          type: "update",
          kind: "agent",
          id: "profile",
          changes: { permissionProfile: "workspace_write" },
          confirmed: true,
        },
        ctx,
      ),
    );
  run((state, ctx) =>
    createTask(
      state,
      {
        ...(browser ? { browser: { mode: "visible" as const, url: "http://127.0.0.1:3456" } } : {}),
        id: "manual",
        title: "Check",
        brief: "Check status",
        profileId: "profile",
        node: { type: "project", id: "p" },
      },
      ctx,
    ),
  );
  run((state, ctx) => startTask(state, "manual", 1, ctx));
  run((state, ctx) =>
    finishTaskTurn(state, "manual", 1, { status: "completed", text: "Manual result" }, ctx),
  );
  const routine = run((state, ctx) =>
    routineFromTask(
      state,
      {
        id: "r",
        name: "Check",
        taskId: "manual",
        schedule: { cron: "@every 60m", timezone: "UTC" },
        notify: "actionable_only",
        permissionCeiling: "full_access",
      },
      ctx,
    ),
  ) as Routine;
  const runner = taskRunner({
    store: f.store,
    now: () => now,
    routinePollMs: 60_000,
    publish() {},
    checkPublic: async () => () => {},
  });
  return {
    ...f,
    run,
    runner,
    routine,
    setNow(at: string) {
      now = at;
    },
    occurrences: () => f.store.snapshot(["routineOccurrence"]).routineOccurrence ?? [],
    close() {
      runner.close();
      f.close();
    },
  };
}
it("commits occurrence, task and receipt atomically at every rollback boundary; replay and a different receipt cannot duplicate it", async () => {
  const f = await fixture();
  try {
    expect(f.routine.permissionCeiling).toBe("read_only");
    const id = "fire",
      scheduled = f.routine.nextRunAt;
    const produce = (state: DomainState) =>
      fireRoutine(state, f.routine, scheduled, "fire", {
        commandId: id,
        at: scheduled,
        actor: { kind: "system", id: "routine" },
      });
    for (const killPoint of [
      "before_events",
      "after_events",
      "after_projections",
      "after_receipt",
    ] as const) {
      expect(() => f.store.dispatch(id, produce, { killPoint })).toThrow("kill point");
      expect(f.occurrences()).toHaveLength(0);
      expect(f.store.snapshot(["task"]).task).toHaveLength(1);
      expect(f.store.receipt(id)).toBeUndefined();
    }
    const first = f.store.dispatch(id, produce);
    expect(
      f.store.dispatch(id, () => {
        throw new Error("replayed");
      }),
    ).toEqual(first);
    f.store.dispatch("another-receipt", produce);
    expect(f.occurrences()).toHaveLength(1);
    expect(f.store.snapshot(["task"]).task).toHaveLength(2);
    expect(f.occurrences()[0]?.id).toBe(`r@${scheduled}`);
    expect(f.store.record("task", String(f.occurrences()[0]?.taskId))).toMatchObject({
      permissionCeiling: "read_only",
      revision: 1,
    });
  } finally {
    f.close();
  }
});
it("collapses three missed runs after sleep into at most one catch-up, and never replays older misses", async () => {
  const f = await fixture();
  try {
    f.setNow("2026-11-04T03:10:00.000Z");
    await f.runner.schedule();
    expect(f.occurrences().map((row) => row.status)).toEqual(["missed", "missed", "queued"]);
    expect(f.store.snapshot(["task"]).task).toHaveLength(2);
    await f.runner.schedule();
    expect(f.occurrences()).toHaveLength(3);
    expect(f.occurrences()[2]?.status).toBe("started");
    f.setNow("2026-11-04T04:40:00.000Z");
    await f.runner.schedule();
    expect(f.occurrences()[3]?.status).toBe("missed");
  } finally {
    f.close();
  }
});
it("skips a new occurrence when its previous task is active", async () => {
  const f = await fixture();
  try {
    f.setNow(f.routine.nextRunAt);
    await f.runner.schedule();
    f.setNow("2026-11-04T02:00:00.000Z");
    await f.runner.schedule();
    expect(f.occurrences()[1]).toMatchObject({
      status: "skipped",
      reason: "Previous occurrence is still active",
    });
    expect(f.store.snapshot(["task"]).task).toHaveLength(2);
  } finally {
    f.close();
  }
});
it("shows the folder queue reason then skips after the named bounded wait", async () => {
  const f = await fixture(true);
  try {
    f.run((state, ctx) =>
      createTask(
        state,
        {
          id: "holder",
          title: "Holder",
          brief: "Hold folder",
          profileId: "profile",
          node: { type: "project", id: "p" },
        },
        ctx,
      ),
    );
    await f.runner.schedule();
    f.setNow(f.routine.nextRunAt);
    await f.runner.schedule();
    const taskId = String(f.occurrences()[0]?.taskId);
    expect(f.store.record("task", taskId)?.holdReason).toContain('Waiting for "Holder"');
    f.setNow(new Date(Date.parse(f.routine.nextRunAt) + ROUTINE_FOLDER_WAIT_MS).toISOString());
    await f.runner.schedule();
    expect(f.occurrences()[0]?.status).toBe("skipped");
    expect(f.store.record("task", taskId)?.state).toBe("cancelled");
  } finally {
    f.close();
  }
});
it("expires unattended requests across restart, releases the folder, and permits the next occurrence", async () => {
  const f = await fixture(true);
  try {
    f.setNow(f.routine.nextRunAt);
    await f.runner.schedule();
    const taskId = String(f.occurrences()[0]?.taskId),
      threadId = `${taskId}:thread`;
    f.run((state, ctx) =>
      requestInteraction(
        state,
        {
          id: "approval",
          threadId,
          agentId: "profile",
          type: "approval",
          items: [
            {
              id: "one",
              prompt: "Allow wider access?",
              choices: [{ id: "allow_once" }, { id: "reject_once" }],
            },
          ],
          chain: [],
          urgency: "blocking",
        },
        "approval:item",
        ctx,
      ),
    );
    await f.runner.schedule();
    expect(f.occurrences()[0]).toMatchObject({
      outcome: "needs_you",
      permissionDeadline: "2026-11-04T01:30:00.000Z",
    });
    recover(f.store, "boot", "2026-11-04T01:10:00.000Z");
    expect(f.store.record("task", taskId)?.holdReason).toBe("routine_needs_you");
    f.setNow(
      new Date(Date.parse(f.routine.nextRunAt) + ROUTINE_PERMISSION_TIMEOUT_MS).toISOString(),
    );
    await f.runner.schedule();
    expect(f.occurrences()[0]?.status).toBe("expired");
    f.setNow("2026-11-04T02:00:00.000Z");
    await f.runner.schedule();
    expect(f.occurrences()[1]?.taskId).toBeDefined();
  } finally {
    f.close();
  }
});
it("uses the notification path with outcome filtering and deferred quiet-window delivery", async () => {
  const planner = new NotificationPlanner();
  const context = {
    focusedThreadId: undefined,
    idle: true,
    previews: false,
    enabled: true,
    agentNames: new Map<string, string>(),
  };
  const f = await fixture();
  try {
    f.setNow(f.routine.nextRunAt);
    await f.runner.schedule();
    const raw = f.occurrences()[0];
    const base = {
      ...raw,
      status: "completed",
      outcome: "nothing",
    } as import("@zoltbot/protocol").RoutineOccurrence;
    expect(planner.reconcileRoutines([base], context)).toEqual([]);
    expect(
      planner.reconcileRoutines([{ ...base, outcome: "actionable" }], { ...context, quiet: true }),
    ).toEqual([]);
    expect(planner.reconcileRoutines([{ ...base, outcome: "actionable" }], context)).toHaveLength(
      1,
    );
    expect(planner.reconcileRoutines([{ ...base, outcome: "actionable" }], context)).toEqual([]);
    expect(
      new NotificationPlanner().reconcileRoutines([{ ...base, notify: "always" }], context),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("edits only future occurrences, preserves paused history and reuses the original folder", async () => {
  const f = await fixture(true);
  try {
    f.setNow(f.routine.nextRunAt);
    await f.runner.schedule();
    const firstTask = f.store.record("task", String(f.occurrences()[0]?.taskId));
    f.setNow("2026-11-04T01:10:00.000Z");
    const updated = (await f.runner.api(
      "routine.update",
      {
        id: "r",
        expectedUpdatedAt: f.store.record("routine", "r")?.updatedAt,
        template: {
          ...f.routine.template,
          brief: "Changed brief",
          inputs: { knowledge: [], skills: [], connections: [] },
        },
        paused: true,
      },
      "edit",
    )) as Routine;
    expect(firstTask?.brief).toBe("Check status");
    expect(f.store.record("task", String(f.occurrences()[0]?.taskId))).toEqual(firstTask);
    expect(updated.template.inputs).toEqual({ knowledge: [], skills: [], connections: [] });
    f.setNow("2026-11-04T05:00:00.000Z");
    await f.runner.schedule();
    expect(f.occurrences()).toHaveLength(1);
    const resumed = (await f.runner.api(
      "routine.update",
      { id: "r", expectedUpdatedAt: updated.updatedAt, paused: false },
      "unpause",
    )) as Routine;
    expect(resumed.nextRunAt).toBe("2026-11-04T06:00:00.000Z");
    expect(f.routine.template.workspaceId).toBe("r:folder");
    expect(f.store.record("workspace", "r:folder")?.path).toBe(f.root);
  } finally {
    f.close();
  }
});

it("allows at most one daemon-wide catch-up after wake, even with multiple routines", async () => {
  const f = await fixture();
  try {
    f.run((state, ctx) =>
      routineFromTask(
        state,
        {
          id: "r2",
          taskId: "manual",
          name: "Another",
          schedule: f.routine.schedule,
          notify: "always",
        },
        ctx,
      ),
    );
    f.setNow("2026-11-04T03:10:00.000Z");
    await f.runner.schedule();
    expect(f.occurrences()).toHaveLength(6);
    expect(f.occurrences().filter((row) => row.taskId)).toHaveLength(1);
    expect(f.occurrences().filter((row) => row.status === "missed")).toHaveLength(5);
  } finally {
    f.close();
  }
});

it("captures source native permissions and commits a needs-you deadline with its request", async () => {
  const f = await fixture();
  try {
    f.run((state, ctx) =>
      handle(
        state,
        {
          type: "create",
          kind: "session",
          value: {
            id: "manual-session",
            threadId: "manual:thread",
            provider: "reference",
            cwd: f.root,
            state: "starting",
            capabilities: {},
            startedAt: initial,
          },
        },
        ctx,
      ),
    );
    f.run((state, ctx) =>
      handle(
        state,
        {
          type: "create",
          kind: "settings",
          value: {
            key: "runtime.configuration.manual-session",
            value: { profile: { permissionProfile: "read_only" } },
          },
        },
        ctx,
      ),
    );
    f.run((state, ctx) =>
      handle(
        state,
        {
          type: "update",
          kind: "agent",
          id: "profile",
          changes: { permissionProfile: "full_access" },
          confirmed: true,
        },
        ctx,
      ),
    );
    const captured = f.run((state, ctx) =>
      routineFromTask(
        state,
        {
          id: "captured",
          taskId: "manual",
          name: "Captured",
          schedule: f.routine.schedule,
          notify: "always",
          permissionCeiling: "full_access",
        },
        ctx,
      ),
    ) as Routine;
    expect(captured.permissionCeiling).toBe("read_only");
    f.setNow(f.routine.nextRunAt);
    await f.runner.schedule();
    const occurrence = f.occurrences().find((row) => row.taskId);
    const threadId = `${String(occurrence?.taskId)}:thread`;
    const produce = (state: DomainState) =>
      requestInteraction(
        state,
        {
          id: "atomic-request",
          threadId,
          agentId: "profile",
          type: "approval",
          items: [{ id: "one", prompt: "Widen?", choices: [{ id: "allow_once" }] }],
          chain: [],
          urgency: "blocking",
          timeout: { seconds: 1, onTimeout: "use_default" },
        },
        "atomic-item",
        {
          commandId: "request",
          at: f.routine.nextRunAt,
          actor: { kind: "system", id: "provider" },
        },
      );
    expect(() => f.store.dispatch("request", produce, { killPoint: "after_projections" })).toThrow(
      "kill point",
    );
    expect(
      f.store.record("routineOccurrence", String(occurrence?.id))?.permissionDeadline,
    ).toBeUndefined();
    f.store.dispatch("request", produce);
    expect(f.store.record("routineOccurrence", String(occurrence?.id))?.permissionDeadline).toBe(
      "2026-11-04T01:30:00.000Z",
    );
    expect(f.store.record("interaction", "atomic-request")?.timeout).toBeUndefined();
  } finally {
    f.close();
  }
});

it("never uses a saved approval rule to widen an unattended routine request", async () => {
  const f = await fixture();
  const { InteractionEngine } = await import("./interaction-engine.js");
  let replies = 0;
  const engine = new InteractionEngine({
    store: f.store,
    now: () => f.routine.nextRunAt,
    publish() {},
    host: {
      registerSecret() {},
      requiresSecretReply: () => false,
      async respond() {
        replies++;
      },
    },
  });
  try {
    f.run((state, ctx) =>
      handle(
        state,
        {
          type: "create",
          kind: "rule",
          confirmed: true,
          value: {
            id: "saved-rule",
            scope: "global",
            matcher: { tool: "Bash", command: { prefix: ["git", "status"] } },
            decision: "allow",
            createdBy: ctx.actor,
            createdAt: ctx.at,
          },
        },
        ctx,
      ),
    );
    f.setNow(f.routine.nextRunAt);
    await f.runner.schedule();
    const occurrence = f.occurrences()[0];
    engine.request(
      {
        id: "native-request",
        agentId: "profile",
        threadId: `${String(occurrence?.taskId)}:thread`,
        type: "approval",
        context: { toolName: "Bash", command: "git status" },
        items: [
          { id: "one", prompt: "Allow?", choices: [{ id: "allow_once" }, { id: "reject_once" }] },
        ],
        chain: [],
        urgency: "blocking",
      },
      "native-command",
    );
    await engine.stopTimers();
    expect(replies).toBe(0);
    expect(f.store.record("interaction", "native-request")?.state).toBe("pending");
    expect(f.store.record("routineOccurrence", String(occurrence?.id))?.outcome).toBe("needs_you");
  } finally {
    await engine.stopTimers();
    f.close();
  }
});

it("dispatches an explicitly browser-enabled routine as a fresh task with background isolation using the existing scheduler", async () => {
  const f = await fixture(false, true);
  try {
    expect(f.routine.template.inputs.browser).toEqual({
      mode: "background",
      url: "http://127.0.0.1:3456",
    });
    const at = f.routine.nextRunAt;
    f.run((state, context) => fireRoutine(state, f.routine, at, "fire", { ...context, at }));
    const task = f.store.snapshot(["task"]).task?.find((t) => t.routineOccurrenceId);
    expect(task?.browser).toEqual(f.routine.template.inputs.browser);
    expect(task?.threadId).not.toBe(f.store.record("task", "manual")?.threadId);
    expect(f.occurrences()).toHaveLength(1);
  } finally {
    f.close();
  }
});
