import { expect, it } from "vitest";
import { requestSessionConnect } from "./session-connect.js";

const context = {
  commandId: "connect",
  at: "2026-10-28T12:00:00Z",
  actor: { kind: "human" as const, id: "owner" },
};
const state = {
  thread: [{ id: "thread", archived: false }],
  session: [{ id: "old", threadId: "thread", state: "closed", startedAt: context.at }],
};
it("fences against the newest generation even when its clock is older", () => {
  const reordered = {
    ...state,
    session: [
      { ...state.session[0], id: "first", generation: 1, startedAt: "2099-01-01T00:00:00Z" },
      { ...state.session[0], id: "second", generation: 2, startedAt: "2000-01-01T00:00:00Z" },
    ],
  };
  expect(
    requestSessionConnect(reordered, "thread", "second", context).result.previousSessionId,
  ).toBe("second");
  expect(() => requestSessionConnect(reordered, "thread", "first", context)).toThrow(
    "session_connection_changed",
  );
});
it("records an auditable connection intent for the displayed terminal session", () => {
  const result = requestSessionConnect(state, "thread", "old", context);
  expect(result.result).toEqual({
    kind: "session_connect",
    threadId: "thread",
    previousSessionId: "old",
  });
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.payload).toMatchObject({
    action: "session.connect",
    target: "thread",
    actor: context.actor,
  });
});
it("fences the actor, archived thread, changed session, active owner, and cleanup quarantine", () => {
  expect(() =>
    requestSessionConnect(state, "thread", "old", {
      ...context,
      actor: { kind: "agent", id: "worker" },
    }),
  ).toThrow("human_connection_required");
  expect(() =>
    requestSessionConnect(
      { ...state, thread: [{ id: "thread", archived: true }] },
      "thread",
      "old",
      context,
    ),
  ).toThrow("thread_unavailable");
  expect(() => requestSessionConnect(state, "thread", "stale", context)).toThrow(
    "session_connection_changed",
  );
  expect(() =>
    requestSessionConnect(
      { ...state, session: [{ ...state.session[0], state: "ready" }] },
      "thread",
      "old",
      context,
    ),
  ).toThrow("session_already_connected");
  expect(() =>
    requestSessionConnect(
      { ...state, session: [{ ...state.session[0], endReason: "runtime_cleanup_required" }] },
      "thread",
      "old",
      context,
    ),
  ).toThrow("runtime_cleanup_required");
});
