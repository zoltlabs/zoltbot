import type { DomainEvent } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { applyEvent, createClient } from "./client.js";
import type { TransportHandlers } from "./transport.js";

it("passes unsequenced Quick Chat events to listeners without touching the snapshot", async () => {
  let handlers: TransportHandlers | undefined;
  const client = createClient({
    kind: "relay",
    start(next) {
      handlers = next;
      next.status("online");
    },
    async call(method) {
      if (method === "events.subscribe") return { seq: 0, resync: true, events: [] };
      return { seq: 0, entities: {}, counters: {} };
    },
    stop() {},
  });
  await vi.waitFor(() => expect(client.getState().status).toBe("online"));
  const seen: DomainEvent[] = [];
  const stop = client.onEvent((event) => seen.push(event));
  const event = {
    eventId: "e1",
    aggregateType: "quickMessage",
    aggregateId: "m1",
    type: "quickMessage.changed",
    occurredAt: "2026-11-06T12:00:00.000Z",
    payload: { id: "m1", chatId: "c1", text: "Hi" },
  } as DomainEvent;
  const before = client.getState().snapshot;
  handlers?.event(event);
  stop();
  handlers?.event(event);
  expect(seen).toEqual([event]);
  expect(client.getState().snapshot).toBe(before);
  client.stop();
});

it("replaces compare member votes by thread identity without duplicate rows", () => {
  const before = {
    seq: 1,
    entities: {
      compareMember: [
        { threadId: "a", compareId: "c", vote: null },
        { threadId: "b", compareId: "c", vote: "better" },
      ],
    },
    counters: {},
  };
  const next = applyEvent(before, {
    seq: 2,
    eventId: "vote",
    aggregateType: "compareMember",
    aggregateId: "a",
    type: "compareMember.updated",
    occurredAt: "2026-11-06T12:00:00.000Z",
    payload: { threadId: "a", compareId: "c", vote: "better" },
  } as DomainEvent);
  expect(next.entities.compareMember).toHaveLength(2);
  expect(next.entities.compareMember?.find((r) => r.threadId === "a")?.vote).toBe("better");
  expect(before.entities.compareMember[0]?.vote).toBeNull();
});
