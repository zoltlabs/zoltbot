import { expect, it } from "vitest";
import { applyEvents } from "./projectors.js";
import { requestTurnInterrupt } from "./turn-interrupt.js";

const context = {
  commandId: "stop",
  at: "2026-10-28T12:00:00Z",
  actor: { kind: "human" as const, id: "owner" },
};
const base = {
  thread: [{ id: "thread", archived: false }],
  session: [
    {
      id: "session",
      threadId: "thread",
      state: "running",
      provider: "reference",
      cwd: "/fixture",
      startedAt: context.at,
      capabilities: { interrupt: "native" },
    },
  ],
  turn: [
    {
      id: "turn",
      threadId: "thread",
      sessionId: "session",
      status: "running",
      origin: "human",
      startedAt: context.at,
    },
  ],
};
it("records an attributed stop request and audit without fabricating native completion", () => {
  const outcome = requestTurnInterrupt(base, "thread", "turn", "note", context);
  const state = applyEvents(base, outcome.events);
  expect(state.turn).toEqual(base.turn);
  expect(state.item?.[0]).toMatchObject({
    id: "note",
    threadId: "thread",
    turnId: "turn",
    kind: "note",
    body: { code: "turn_interrupt", state: "requested", sessionId: "session", turnId: "turn" },
  });
  expect(state.audit?.[0]).toMatchObject({
    action: "turn.interrupt",
    actor: context.actor,
    target: "turn",
    result: "allowed",
  });
  expect(outcome.result).toEqual({
    kind: "interrupt",
    id: "note",
    threadId: "thread",
    turnId: "turn",
    sessionId: "session",
  });
});
it("rejects stale targets, foreign sessions, archived threads, unsupported capabilities, and nonhuman callers", () => {
  expect(() => requestTurnInterrupt(base, "thread", "later", "note", context)).toThrow(
    "interrupt_turn_changed",
  );
  expect(() =>
    requestTurnInterrupt(
      { ...base, session: [{ ...base.session[0], threadId: "other" }] },
      "thread",
      "turn",
      "note",
      context,
    ),
  ).toThrow("runtime_session_unavailable");
  expect(() =>
    requestTurnInterrupt(
      { ...base, thread: [{ id: "thread", archived: true }] },
      "thread",
      "turn",
      "note",
      context,
    ),
  ).toThrow("runtime_thread_unavailable");
  expect(() =>
    requestTurnInterrupt(
      { ...base, session: [{ ...base.session[0], capabilities: {} }] },
      "thread",
      "turn",
      "note",
      context,
    ),
  ).toThrow("unsupported_interrupt");
  expect(() =>
    requestTurnInterrupt(base, "thread", "turn", "note", {
      ...context,
      actor: { kind: "system", id: "runtime" },
    }),
  ).toThrow("human_interrupt_required");
  expect(() =>
    requestTurnInterrupt(
      { ...base, turn: [{ ...base.turn[0], status: "completed" }] },
      "thread",
      "turn",
      "note",
      context,
    ),
  ).toThrow("interrupt_turn_changed");
});
it("requires a pending interruption to finish before another request for the same turn", () => {
  const state = applyEvents(
    base,
    requestTurnInterrupt(base, "thread", "turn", "note", context).events,
  );
  expect(() =>
    requestTurnInterrupt(state, "thread", "turn", "next", { ...context, commandId: "next" }),
  ).toThrow("interrupt_already_requested");
});
it("settles the request only from the owned native turn completion", async () => {
  const { observeRuntimeEvent } = await import("./runtime-events.js");
  const state = applyEvents(
    base,
    requestTurnInterrupt(base, "thread", "turn", "note", context).events,
  );
  const outcome = observeRuntimeEvent(
    state,
    {
      threadId: "thread",
      sessionId: "session",
      event: { t: "turn.done", turnId: "turn", status: "interrupted" },
    },
    { ...context, commandId: "native", actor: { kind: "system", id: "runtime" } },
  );
  expect(applyEvents(state, outcome.events).item?.[0]?.body).toMatchObject({
    state: "completed",
    confirmation: "native_event",
  });
});
