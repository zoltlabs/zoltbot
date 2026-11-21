// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../shared/ipc";
import type { Row, Snapshot } from "./daemon-client";
import {
  noticeFor,
  parseTaskAction,
  relatedThreads,
  runTaskAction,
  withManagerCards,
} from "./manager-cards";

const at = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`;
const snapshot = (entities: Record<string, Row[]>): Snapshot => ({
  seq: 1,
  entities,
  counters: {},
});
const text = (value: string) => [{ type: "text", text: value }];

const entities = (): Record<string, Row[]> => ({
  thread: [
    { id: "mgr", title: "Payments", agentId: "a", archived: false },
    { id: "mira", title: "Mira", agentId: "a", archived: false },
    { id: "theo", title: "Theo", agentId: "a", archived: false },
  ],
  turn: [{ id: "turn1", threadId: "mgr", startedAt: at(0), endedAt: at(5) }],
  message: [
    { id: "msg1", fromThread: "mgr", thread: "mira", kind: "task", createdAt: at(1) },
    { id: "msg2", fromThread: "mgr", thread: "theo", kind: "task", createdAt: at(2) },
    {
      id: "msg3",
      fromThread: "mgr",
      thread: "theo",
      kind: "message",
      expectsReply: true,
      createdAt: at(3),
      body: text("[Message from Payments]\nCan you check the refund path?"),
    },
  ],
  task: [
    {
      id: "task1",
      title: "Add refund endpoint",
      threadId: "mira",
      state: "running",
      sourceMessageId: "msg1",
      accountableThreadId: "mgr",
      budgetUsd: 2,
      revision: 1,
      createdAt: at(1),
    },
    {
      id: "task2",
      title: "Write refund tests",
      threadId: "theo",
      state: "review",
      sourceMessageId: "msg2",
      accountableThreadId: "mgr",
      revision: 3,
      createdAt: at(2),
      updatedAt: at(8),
    },
  ],
  usage: [
    { id: "u1", taskId: "task1", costUsd: 0.4 },
    { id: "u2", taskId: "task1", costUsd: 0.2 },
  ],
  taskResult: [
    { id: "r1", taskId: "task2", revision: 3, files: ["src/refund.test.ts"], createdAt: at(8) },
  ],
  deliverable: [{ id: "d1", taskId: "task2", version: 1, validationState: "passed" }],
  item: [
    {
      id: "note",
      threadId: "mgr",
      kind: "message",
      seq: 9,
      createdAt: at(9),
      body: { text: "Tests look good to me." },
    },
  ],
  settings: [
    {
      id: "s1",
      key: "team.wait.mgr",
      value: {
        id: "wait1",
        status: "waiting",
        taskIds: ["task1"],
        chatIds: ["theo"],
        updatedAt: at(10),
      },
    },
  ],
});

const message = (id: string, createdAt: string, turnId?: string): ConversationMessage =>
  ({
    id,
    author: "assistant",
    source: "agent",
    text: id,
    createdAt,
    status: "completed",
    ...(turnId ? { turnId } : {}),
  }) as ConversationMessage;

describe("withManagerCards", () => {
  const conversation = [message("reply", at(4), "turn1"), message("note", at(9))];

  it("adds one delegation card per turn after its last message", () => {
    const list = withManagerCards(snapshot(entities()), "mgr", conversation);
    const ids = list.map((row) => row.id);
    expect(ids.slice(0, 3)).toEqual(["notice:sent:msg3", "reply", "card:delegation:turn1"]);
    const card = list[2]?.card;
    if (card?.kind !== "delegation") throw new Error("expected a delegation card");
    expect(card.rows.map((row) => [row.title, row.owner, row.status])).toEqual([
      ["Add refund endpoint", "Mira", "running"],
      ["Write refund tests", "Theo", "review"],
    ]);
    expect(card.rows[0]?.costUsd).toBeCloseTo(0.6);
    expect(card.rows[0]?.budgetUsd).toBe(2);
  });

  it("adds a result card after the manager's note", () => {
    const list = withManagerCards(snapshot(entities()), "mgr", conversation);
    const index = list.findIndex((row) => row.id === "card:result:task2");
    expect(list[index - 1]?.id).toBe("note");
    expect(list[index]?.card).toMatchObject({
      kind: "result",
      taskId: "task2",
      revision: 3,
      owner: "Theo",
      files: ["src/refund.test.ts"],
      tests: "passed",
      note: "Tests look good to me.",
    });
  });

  it("shows sent messages and an open wait as notices", () => {
    const list = withManagerCards(snapshot(entities()), "mgr", conversation);
    const sent = list.find((row) => row.id === "notice:sent:msg3")?.notice;
    expect(sent).toMatchObject({
      kind: "team",
      from: { name: "Payments" },
      to: { name: "Theo" },
      text: "Can you check the refund path?",
      meta: "waiting for a reply",
    });
    const waiting = list.at(-1);
    expect(waiting?.id).toBe("notice:waiting:wait1");
    expect(waiting?.notice).toMatchObject({
      kind: "waiting",
      text: "1 task and 1 chat",
      detail: "Add refund endpoint, Theo",
      waitId: "wait1",
    });
  });

  it("adds nothing to a chat that delegated nothing", () => {
    const list = withManagerCards(snapshot(entities()), "mira", conversation);
    expect(list.map((row) => row.id)).toEqual(["reply", "note"]);
  });
});

describe("noticeFor", () => {
  const state = snapshot(entities());
  it("reads team, supervision and wait notices from metadata", () => {
    expect(
      noticeFor(state, {
        threadId: "mira",
        body: {
          notice: {
            kind: "team",
            type: "brief",
            messageId: "msg1",
            fromThreadId: "mgr",
            preview: "Add refund endpoint",
          },
        },
      }),
    ).toMatchObject({
      kind: "team",
      from: { name: "Payments" },
      to: { name: "Mira" },
      text: "Add refund endpoint",
      meta: "assignment",
    });
    expect(
      noticeFor(state, {
        threadId: "mgr",
        body: { notice: { kind: "supervision", taskId: "task2", state: "review" } },
      }),
    ).toMatchObject({ from: { name: "Theo" }, verb: "finished", text: "Write refund tests" });
    expect(
      noticeFor(state, {
        threadId: "mgr",
        body: { notice: { kind: "wait", waitId: "wait1", state: "fallback" } },
      }),
    ).toMatchObject({ kind: "wait", meta: "fallback time passed" });
    expect(
      noticeFor(state, { threadId: "mgr", body: { notice: { kind: "continue" } } }),
    ).toMatchObject({
      kind: "continue",
      from: { name: "Payments" },
      verb: "continued automatically",
    });
  });

  it("shows Zoltbot's wake-ups and notices as notices, not the person's words", () => {
    const input = (value: string) => ({ input: [{ type: "text", text: value }] });
    const wake =
      "[Zoltbot] Zolt, this is a wake-up, not a message from the user.\nNew for the user:\n- approval";
    expect(
      noticeFor(state, { id: "chief-wake:abc", kind: "user", threadId: "zolt", body: input(wake) }),
    ).toEqual({
      kind: "zoltbot",
      text: "Woke up on its own",
      detail: "New for the user:\n- approval",
    });
    expect(
      noticeFor(state, {
        id: "chief-wake:brief:2026-11-20",
        kind: "user",
        threadId: "zolt",
        body: input("[Zoltbot] Morning.\nWrite the brief."),
      }),
    ).toMatchObject({ kind: "zoltbot", text: "Morning brief" });
    expect(
      noticeFor(state, {
        id: "n1",
        kind: "user",
        threadId: "mira",
        body: input("[Zoltbot] The checks finished."),
      }),
    ).toMatchObject({ kind: "zoltbot", text: "The checks finished." });
    expect(
      noticeFor(state, { id: "u1", kind: "user", threadId: "mira", body: input("Hello") }),
    ).toBeUndefined();
  });

  it("shows the owner's channel post as from You", () => {
    const owned = snapshot({
      ...entities(),
      message: [
        {
          id: "post1:to:0",
          thread: "mgr",
          channelId: "channel-payments",
          from: { kind: "human", id: "local-owner" },
          origin: "human",
          kind: "message",
          body: text("[#payments · request from the owner]\nShip the refund fix"),
          createdAt: at(3),
        },
      ],
    });
    expect(
      noticeFor(owned, {
        threadId: "mgr",
        body: {
          notice: {
            kind: "team",
            type: "question",
            messageId: "post1:to:0",
            channelId: "channel-payments",
            preview: "Ship the refund fix",
          },
        },
      }),
    ).toMatchObject({
      from: { name: "You", botId: null },
      to: { name: "Payments" },
      text: "Ship the refund fix",
    });
  });

  it("leaves ordinary user input alone", () => {
    expect(noticeFor(state, { threadId: "mgr", body: { input: text("Hello") } })).toBeUndefined();
  });
});

describe("task actions", () => {
  it("validates input", () => {
    expect(parseTaskAction({ action: "stop", taskId: "task1" })).toEqual({
      action: "stop",
      taskId: "task1",
    });
    expect(() => parseTaskAction({ action: "accept", taskId: "task1" })).toThrow("revision");
    expect(() => parseTaskAction({ action: "delete" })).toThrow("Unknown");
  });

  it("sends each action with a stable command id", async () => {
    const call = vi.fn(async () => ({}));
    await runTaskAction(call, { action: "stop", taskId: "task1" });
    await runTaskAction(call, { action: "accept", taskId: "task2", revision: 3 });
    await runTaskAction(call, {
      action: "send_back",
      taskId: "task2",
      revision: 3,
      feedback: "Cover partial refunds",
    });
    await runTaskAction(call, { action: "wake_now", threadId: "mgr", waitId: "wait1" });
    expect(call.mock.calls).toEqual([
      ["task.cancel", { id: "task1", confirmed: true }, "shell:stop:task1"],
      [
        "task.review",
        { id: "task2", revision: 3, decision: "accept", confirmed: true },
        "shell:accept:task2:3",
      ],
      [
        "task.review",
        {
          id: "task2",
          revision: 3,
          decision: "changes",
          feedback: "Cover partial refunds",
          confirmed: true,
        },
        "shell:send_back:task2:3",
      ],
      ["company.wakeNow", { threadId: "mgr", waitId: "wait1" }, "shell:wake:wait1"],
    ]);
  });

  it("refreshes the manager's chat when a delegated task changes", () => {
    const state = snapshot(entities());
    expect(relatedThreads(state, "usage", { taskId: "task1" })).toEqual(["mgr", "mgr"]);
    expect(relatedThreads(state, "settings", { key: "team.wait.mgr" })).toEqual(["mgr"]);
  });
});
