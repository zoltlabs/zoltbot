import { expect, test } from "vitest";
import { inboxFromSnapshot, openedInboxRow } from "./data.js";

test("keeps an answered conversation open after marking its finished turn read", () => {
  const thread = {
    id: "chat",
    kind: "main",
    archived: false,
    lastActivityAt: "2026-11-01T12:00:00Z",
    lastReadAt: "2026-11-01T12:00:00Z",
  };
  const entities = {
    thread: [thread],
    turn: [{ id: "turn", threadId: "chat", status: "completed", endedAt: thread.lastReadAt }],
    interaction: [{ id: "approval", threadId: "chat", type: "approval", state: "answered" }],
  };
  const { items, counts } = inboxFromSnapshot(entities);
  expect(items).toEqual([]);
  expect(counts.needs_you).toBe(0);
  expect(openedInboxRow(items, entities, "chat")).toMatchObject({
    thread,
    unread: false,
    pending: {},
  });
  expect(openedInboxRow(items, entities)).toBeUndefined();
  expect(openedInboxRow(items, { ...entities, thread: [] }, "chat")).toBeUndefined();
  expect(
    openedInboxRow(items, { ...entities, thread: [{ ...thread, archived: true }] }, "chat"),
  ).toBeUndefined();
});

test("a fallback wake returns an unread chat with its reason as the Inbox preview", () => {
  const entities = {
    thread: [
      {
        id: "chat",
        kind: "main",
        archived: false,
        lastReadAt: "2026-11-01T12:00:00Z",
        lastActivityAt: "2026-11-02T12:00:00Z",
        wakeUnreadAt: "2026-11-02T12:00:00Z",
        wakePending: false,
      },
    ],
    item: [
      {
        id: "wake-note",
        threadId: "chat",
        kind: "note",
        seq: 1,
        body: { code: "wake", text: "Fallback reached; the condition has not been confirmed" },
      },
    ],
  };
  expect(inboxFromSnapshot(entities).items[0]).toMatchObject({
    mailbox: "review",
    unread: true,
    preview: "Fallback reached; the condition has not been confirmed",
  });
});
