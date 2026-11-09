import { expect, it } from "vitest";
import { queueHumanInput } from "./input-queue.js";
import { applyEvents } from "./projectors.js";
import { observeRuntimeEvent } from "./runtime-events.js";
import { reserveRuntimeItem } from "./runtime-streams.js";

const at = "2026-10-28T12:00:00Z",
  context = { commandId: "stream", at, actor: { kind: "system" as const, id: "runtime" } };
const base = {
  thread: [
    {
      id: "thread",
      agentId: "profile",
      kind: "main",
      title: "Chat",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    },
  ],
  session: [
    {
      id: "session",
      threadId: "thread",
      state: "ready",
      provider: "reference",
      cwd: "/work/repo",
      capabilities: {},
      startedAt: at,
    },
  ],
};
const started = () =>
  applyEvents(
    base,
    observeRuntimeEvent(
      base,
      { sessionId: "session", threadId: "thread", event: { t: "turn.started", turnId: "turn" } },
      context,
    ).events,
  );
const input = {
  sessionId: "session",
  threadId: "thread",
  itemId: "display",
  event: {
    t: "text.delta",
    turnId: "turn",
    itemId: "native",
    text: "synthetic-private-stream-fragment",
  },
};
it("reserves stable timeline order without persisting raw delta text", () => {
  const first = started(),
    reserved = applyEvents(first, reserveRuntimeItem(first, input, context).events);
  expect(reserved.item?.[0]).toMatchObject({
    id: "display",
    seq: 1,
    kind: "message",
    turnId: "turn",
    body: { text: "", streaming: true, nativeItemId: "native" },
  });
  expect(JSON.stringify(reserved)).not.toContain("synthetic-private-stream-fragment");
  expect(reserveRuntimeItem(reserved, input, context).events).toEqual([]);
  const queued = applyEvents(
    reserved,
    queueHumanInput(
      reserved,
      { threadId: "thread", mode: "queue", input: [{ type: "text", text: "Next human input" }] },
      "human",
      { ...context, actor: { kind: "human", id: "owner" } },
    ).events,
  );
  expect(queued.item?.find((row) => row.id === "human")?.seq).toBe(2);
  const final = applyEvents(
    queued,
    observeRuntimeEvent(
      queued,
      {
        ...input,
        event: {
          t: "message.done",
          turnId: "turn",
          itemId: "native",
          text: "Authoritative complete message",
          phase: "final",
        },
      },
      context,
    ).events,
  );
  expect(final.item?.find((row) => row.id === "display")).toMatchObject({
    seq: 1,
    body: { text: "Authoritative complete message" },
  });
  expect(
    (final.item?.find((row) => row.id === "display")?.body as Record<string, unknown>).streaming,
  ).toBeUndefined();
  expect(reserveRuntimeItem(final, input, context).events).toEqual([]);
});
it("fences stream reservations by owned turn, display identity and item kind", () => {
  const state = started();
  expect(() =>
    reserveRuntimeItem(state, { ...input, event: { ...input.event, turnId: "foreign" } }, context),
  ).toThrow("runtime_turn_missing");
  const reserved = applyEvents(state, reserveRuntimeItem(state, input, context).events);
  expect(() =>
    reserveRuntimeItem(
      reserved,
      {
        ...input,
        event: { t: "thought.delta", turnId: "turn", itemId: "native", text: "thought" },
      },
      context,
    ),
  ).toThrow("runtime_item_conflict");
  const ended = applyEvents(
    reserved,
    observeRuntimeEvent(
      reserved,
      {
        sessionId: "session",
        threadId: "thread",
        event: { t: "turn.done", turnId: "turn", status: "completed" },
      },
      context,
    ).events,
  );
  expect(reserveRuntimeItem(ended, input, context).events).toEqual([]);
});
it("ends unfinished placeholders without leaving a permanent streaming indicator", () => {
  const first = started(),
    state = applyEvents(first, reserveRuntimeItem(first, input, context).events);
  const ended = applyEvents(
    state,
    observeRuntimeEvent(
      state,
      {
        sessionId: "session",
        threadId: "thread",
        event: { t: "turn.done", turnId: "turn", status: "interrupted" },
      },
      context,
    ).events,
  );
  expect(ended.item?.[0]?.body).toMatchObject({
    text: "",
    streaming: false,
    partial: true,
    interrupted: true,
  });
});
