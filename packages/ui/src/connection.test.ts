import type { DomainEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { applyStreamEvent, type Snapshot } from "./connection.js";

const at = "2026-10-28T12:00:00Z";
const item = {
  id: "display",
  threadId: "thread",
  turnId: "turn",
  kind: "message",
  seq: 2,
  body: { text: "", streaming: true },
  createdAt: at,
  updatedAt: at,
};
const snapshot: Snapshot = {
  seq: 10,
  entities: { item: [item], turn: [{ id: "turn", threadId: "thread", status: "running" }] },
  counters: { pendingInteractions: 2 },
};
const stream = (changes: Record<string, unknown> = {}): DomainEvent => ({
  eventId: "stream",
  aggregateType: "item",
  aggregateId: "display",
  type: "item.stream",
  occurredAt: at,
  payload: { ...item, body: { text: "Visible partial", streaming: true }, ...changes },
});
it("updates live text without moving the durable cursor, ordering, or interaction counters", () => {
  const next = applyStreamEvent(snapshot, stream());
  expect(next.seq).toBe(10);
  expect(next.counters).toBe(snapshot.counters);
  expect(next.entities.item?.[0]).toMatchObject({
    id: "display",
    seq: 2,
    body: { text: "Visible partial", streaming: true },
  });
  expect(snapshot.entities.item?.[0]?.body).toEqual({ text: "", streaming: true });
});
it("ignores late partials after completion and rejects changed stream identity or ordering", () => {
  for (const change of [
    { id: "other" },
    { threadId: "foreign" },
    { turnId: "foreign" },
    { kind: "thought" },
    { seq: 9 },
  ])
    expect(applyStreamEvent(snapshot, stream(change))).toBe(snapshot);
  const completed = {
    ...snapshot,
    entities: { ...snapshot.entities, item: [{ ...item, body: { text: "Authoritative final" } }] },
  };
  expect(applyStreamEvent(completed, stream())).toBe(completed);
  const ended = {
    ...snapshot,
    entities: {
      ...snapshot.entities,
      turn: [{ id: "turn", threadId: "thread", status: "completed" }],
    },
  };
  expect(applyStreamEvent(ended, stream())).toBe(ended);
});
