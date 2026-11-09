import { expect, it } from "vitest";
import { reconcileNativeSessions } from "./native-sessions.js";
import { applyEvents } from "./projectors.js";

const context = {
  commandId: "scan",
  at: "2026-10-27T12:00:00.000Z",
  actor: { kind: "system" as const, id: "session-index" },
};
const row = {
  provider: "codex",
  nativeId: "native-one",
  title: "Original",
  adopted: false,
  missing: false,
  lastSeenAt: "2026-10-26T12:00:00.000Z",
};
it("refreshes provider metadata while preserving adoption and linked history", () => {
  const state = { nativeSession: [{ ...row, adopted: true, threadId: "thread-one" }] };
  const result = reconcileNativeSessions(state, "codex", [{ ...row, title: "Renamed" }], context);
  expect(applyEvents(state, result.events).nativeSession).toEqual([
    { ...row, title: "Renamed", adopted: true, threadId: "thread-one", lastSeenAt: context.at },
  ]);
  expect(state.nativeSession[0]?.title).toBe("Original");
});
it("marks absent sessions missing without deleting linked threads or other providers", () => {
  const state = {
    nativeSession: [row, { ...row, provider: "pi" }],
    thread: [{ id: "cached-thread" }],
  };
  const result = reconcileNativeSessions(state, "codex", [], context);
  const next = applyEvents(state, result.events);
  expect(next.nativeSession).toContainEqual({ ...row, missing: true });
  expect(next.nativeSession).toContainEqual({ ...row, provider: "pi" });
  expect(next.thread).toEqual(state.thread);
});
it("does not mark unrelated cwd sessions missing during a filtered scan", () => {
  const state = {
    nativeSession: [
      { ...row, cwd: "/other" },
      { ...row, nativeId: "two", cwd: "/selected" },
    ],
  };
  const next = applyEvents(
    state,
    reconcileNativeSessions(state, "codex", [], context, { cwd: "/selected" }).events,
  );
  expect(next.nativeSession).toContainEqual({ ...row, cwd: "/other" });
  expect(next.nativeSession).toContainEqual({
    ...row,
    nativeId: "two",
    cwd: "/selected",
    missing: true,
  });
});
it("rejects ambiguous or cross provider results atomically", () => {
  expect(() => reconcileNativeSessions({}, "codex", [row, row], context)).toThrow(
    "duplicate_native_session",
  );
  expect(() => reconcileNativeSessions({}, "codex", [{ ...row, provider: "pi" }], context)).toThrow(
    "native_provider_mismatch",
  );
});
it("restores a returned session and ignores provider supplied adoption claims", () => {
  const state = { nativeSession: [{ ...row, missing: true }] };
  const next = applyEvents(
    state,
    reconcileNativeSessions(
      state,
      "codex",
      [{ ...row, adopted: true, threadId: "untrusted" }],
      context,
    ).events,
  );
  expect(next.nativeSession).toEqual([{ ...row, lastSeenAt: context.at }]);
});
