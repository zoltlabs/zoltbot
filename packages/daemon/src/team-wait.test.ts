import { rmSync } from "node:fs";
import path from "node:path";
import { type Command, handle } from "@zoltbot/core";
import { teamWaitKey } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { companyApi } from "./company-api.js";
import { companySupervisor } from "./company-supervisor.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeTools } from "./runtime-tools.js";

/** Payments manager ("thread") with two employees, plus a Sales chat outside its team. */
async function payments() {
  const f = await runtimeFixture();
  let n = 0;
  const change = (store: Store, command: Command) => {
    const commandId = `change:${++n}`;
    store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  change(f.store, {
    type: "create",
    kind: "project",
    value: {
      id: "co",
      name: "Company",
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
  });
  for (const id of ["pay", "sales"])
    change(f.store, {
      type: "create",
      kind: "subproject",
      value: {
        id,
        projectId: "co",
        name: id,
        label: "Team",
        goal: "",
        instructions: "",
        depth: 1,
        archived: false,
        createdAt: at,
      },
    });
  change(f.store, {
    type: "update",
    kind: "thread",
    id: "thread",
    changes: { kind: "manager", projectId: "co", node: { type: "subproject", id: "pay" } },
  });
  for (const [id, team] of [
    ["mira", "pay"],
    ["theo", "pay"],
    ["sales-chat", "sales"],
  ] as const)
    change(f.store, {
      type: "create",
      kind: "thread",
      value: {
        id,
        agentId: "profile",
        projectId: "co",
        node: { type: "subproject", id: team },
        kind: "side",
        title: id,
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    });
  change(f.store, { type: "transition", kind: "session", id: "session", to: "ready" });
  change(f.store, { type: "transition", kind: "session", id: "session", to: "running" });
  change(f.store, {
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  return { f, change };
}
function contextFor(store: Store, woken: string[]) {
  return {
    store,
    privacy: new PrivateInputGuard({ store, publish() {} }),
    publish() {},
    async wake(id: string) {
      woken.push(id);
    },
  };
}
const manager = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
const call = async (
  tools: ReturnType<typeof runtimeTools>,
  name: string,
  args: Record<string, unknown>,
) => {
  const tool = tools.tools.get(name);
  if (!tool) throw new Error(`missing_${name}`);
  return (await tool({ actor: manager, arguments: args, idempotencyKey: name })) as Record<
    string,
    unknown
  >;
};
const setTask = (store: Store, id: string, state: string, when: string) => {
  const task = store.record("task", id);
  store.dispatch(`set:${id}:${state}`, () => ({
    events: [
      {
        eventId: `set:${id}:${state}:0`,
        commandId: `set:${id}:${state}`,
        aggregateType: "task",
        aggregateId: id,
        type: "task.updated",
        occurredAt: when,
        payload: { ...task, state, updatedAt: when },
      },
    ],
    result: {},
  }));
};

it("lists sent work, waits on it without a card, and wakes once across a restart", async () => {
  const { f } = await payments();
  const dbPath = path.join(f.root, "store.db");
  let store = f.store;
  try {
    const woken: string[] = [];
    const tools = runtimeTools(contextFor(store, woken), { waitMs: 0 });
    for (const chatId of ["mira", "theo"])
      await call(tools, "team_delegate", { key: chatId, brief: `Work for ${chatId}`, chatId });
    const tasks = (store.snapshot(["task"]).task ?? []).filter(
      (t) => t.accountableThreadId === "thread",
    );
    const taskIds = tasks.map((t) => String(t.id));
    expect(taskIds).toHaveLength(2);

    const requests = await call(tools, "team_requests", {});
    expect(requests.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assignment", status: "open", text: "Work for mira" }),
      ]),
    );

    expect(await call(tools, "team_wait", { key: "x", chatIds: ["sales-chat"] })).toMatchObject({
      error: "wait_outside_scope",
    });
    const started = await call(tools, "team_wait", { key: "both", taskIds, note: "Review both" });
    expect(started).toMatchObject({ status: "waiting", wait: { revision: 1 } });
    const seq = store.lastSeq();
    expect(await call(tools, "team_wait", { key: "both", taskIds })).toMatchObject({
      status: "waiting",
    });
    expect(store.lastSeq()).toBe(seq);
    // No wake card: the wait is armed directly, and chat_wake's wake record stays untouched.
    expect(store.snapshot(["wake"]).wake ?? []).toHaveLength(0);

    const later = "2026-10-28T12:10:00.000Z";
    setTask(store, taskIds[0] as string, "review", later);
    await companySupervisor(contextFor(store, woken), { now: () => later }).tick();
    const managerItems = () =>
      (store.snapshot(["item"]).item ?? []).filter((i) => i.threadId === "thread");
    // One task finished: the wait holds its supervision notice back.
    expect(managerItems().filter((i) => String(i.id).startsWith("company:signal:"))).toHaveLength(
      0,
    );

    // Finish the second task, then restart before the supervisor sees it.
    setTask(store, taskIds[1] as string, "review", later);
    store.close();
    store = await openStore(dbPath);
    const afterRestart: string[] = [];
    await companySupervisor(contextFor(store, afterRestart), { now: () => later }).tick();
    const notices = managerItems().filter((i) => String(i.id).startsWith("company:signal:"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toMatchObject({
      origin: "system",
      notice: { kind: "wait", state: "finished" },
    });
    expect(afterRestart).toContain("thread");
    expect(store.record("settings", teamWaitKey("thread"))?.value).toMatchObject({
      status: "woken",
      reason: "finished",
    });
    // A second restart and tick neither repeats the wake nor posts per-task notices.
    store.close();
    store = await openStore(dbPath);
    await companySupervisor(contextFor(store, []), { now: () => later }).tick();
    expect(managerItems().filter((i) => String(i.id).startsWith("company:signal:"))).toHaveLength(
      1,
    );
    // A later change to a covered task is news again.
    setTask(store, taskIds[0] as string, "completed", "2026-10-28T12:20:00.000Z");
    await companySupervisor(contextFor(store, []), {
      now: () => "2026-10-28T12:20:00.000Z",
    }).tick();
    expect(managerItems().filter((i) => String(i.id).startsWith("company:signal:"))).toHaveLength(
      2,
    );
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("lets only the owner wake a waiting chat early", async () => {
  const { f } = await payments();
  try {
    const woken: string[] = [];
    const context = contextFor(f.store, woken);
    const tools = runtimeTools(context, { waitMs: 0 });
    await call(tools, "team_delegate", { key: "mira", brief: "Refunds", chatId: "mira" });
    const taskId = String(
      (f.store.snapshot(["task"]).task ?? []).find((t) => t.accountableThreadId === "thread")?.id,
    );
    const started = await call(tools, "team_wait", { key: "w", taskIds: [taskId] });
    const waitId = String((started.wait as { id: string }).id);
    const api = companyApi(context);
    await expect(
      api("company.wakeNow", { threadId: "thread", waitId }, "agent-wake", {
        agentId: "profile",
        threadId: "thread",
        sessionId: "session",
      } as never),
    ).rejects.toThrow("human_approval_required");
    await api("company.wakeNow", { threadId: "thread", waitId }, "owner-wake");
    await api("company.wakeNow", { threadId: "thread", waitId }, "owner-wake-again");
    expect(woken).toEqual(["thread", "thread"]);
    const notices = (f.store.snapshot(["item"]).item ?? []).filter((i) =>
      String(i.id).startsWith("company:signal:wait:"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toMatchObject({ notice: { kind: "wait", state: "owner" } });
  } finally {
    f.close();
  }
});
