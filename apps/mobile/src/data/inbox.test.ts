import { Value } from "@sinclair/typebox/value";
import { methodCatalog } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { buildReply, emptyDraft, inbox, inboxRow, replyQuestions, snoozeTimes } from "./inbox.js";
import type { Snapshot } from "./transport.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 8, 12, minutes)).toISOString();
const thread = (id: string, extra = {}) => ({
  id,
  agentId: "a",
  kind: "chat",
  title: id,
  archived: false,
  createdAt: at(0),
  lastActivityAt: at(1),
  ...extra,
});
const snapshot: Snapshot = {
  seq: 1,
  counters: {},
  entities: {
    thread: [
      thread("asks"),
      thread("done"),
      thread("read", { lastReadAt: at(30) }),
      thread("away", { archived: true }),
    ],
    turn: [
      { id: "t1", threadId: "done", status: "completed", endedAt: at(20) },
      { id: "t2", threadId: "read", status: "completed", endedAt: at(20) },
    ],
    item: [
      { id: "i", threadId: "done", seq: 1, kind: "message", body: { text: "**Shipped** it" } },
    ],
    interaction: [
      {
        id: "q",
        threadId: "asks",
        type: "question",
        state: "pending",
        version: 1,
        createdAt: at(5),
        items: [{ id: "q1", prompt: "Which?", options: [{ id: "0", label: "This" }] }],
      },
    ],
  },
};

describe("phone inbox", () => {
  it("files threads into the Mac's mailboxes with previews; read, idle ones stay in Chats", () => {
    const now = new Date(Date.UTC(2026, 10, 8, 13));
    const { items, counts } = inbox(snapshot, now);
    expect(items.map((row) => [row.thread.id, row.mailbox ?? null])).toEqual([
      ["asks", "needs_you"],
      ["done", "review"],
      ["away", "settled"],
    ]);
    expect(counts).toMatchObject({ needs_you: 1, review: 1, settled: 1 });
    expect(inboxRow(snapshot, "done", now)?.preview).toBe("Shipped it");
  });

  it("builds a reply the Mac accepts", () => {
    const questions = replyQuestions(snapshot.entities.interaction, "asks");
    const reply = buildReply(questions, { ...emptyDraft(questions), picks: { 1: ["0"] } });
    expect(
      Value.Check(methodCatalog["thread.reply"].params, {
        threadId: "asks",
        body: reply.body,
        answers: reply.answers,
        mode: "queue",
      }),
    ).toBe(true);
    expect(reply.body).toBe("> Q1 · Which?\n\nThis");
  });

  it("offers snoozes in the future, in order", () => {
    const now = new Date(Date.UTC(2026, 10, 8, 13));
    const times = snoozeTimes(now).map((time) => time.at.getTime());
    expect(times.every((time) => time > now.getTime())).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
