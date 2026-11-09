import { expect, it } from "vitest";
import { adoptNativeSession } from "./native-adoption.js";
import { applyEvents } from "./projectors.js";

const context = {
  commandId: "adopt",
  at: "2026-10-27T12:00:00.000Z",
  actor: { kind: "human" as const, id: "owner" },
};
const native = {
  provider: "codex",
  nativeId: "one",
  title: "Existing work",
  adopted: false,
  missing: false,
  lastSeenAt: context.at,
};
const state = {
  agentDefinition: [{ id: "codex-local", adapter: "codex" }],
  agent: [{ id: "profile", definitionId: "codex-local", archived: false }],
  nativeSession: [native],
};
const request = { session: native, profileId: "profile", threadId: "new-thread", confirmed: true };
it("creates a thread, native link, and audit as one outcome without modifying provider history", () => {
  const outcome = adoptNativeSession(state, request, context);
  const next = applyEvents(state, outcome.events);
  expect(next.thread?.[0]).toMatchObject({
    id: "new-thread",
    agentId: "profile",
    title: "Existing work",
    titleSource: "provider",
  });
  expect(next.nativeSession?.[0]).toMatchObject({
    adopted: true,
    threadId: "new-thread",
    nativeId: "one",
  });
  expect(next.audit?.[0]).toMatchObject({ action: "native.adopt", result: "allowed" });
  expect(state.nativeSession[0]?.adopted).toBe(false);
  expect(outcome.events.map((event) => event.eventId)).toEqual(["adopt:0", "adopt:1", "adopt:2"]);
});
it("rejects missing sessions, absent profiles, and unconfirmed changes", () => {
  expect(() => adoptNativeSession(state, { ...request, confirmed: false }, context)).toThrow(
    "adoption_confirmation_required",
  );
  expect(() => adoptNativeSession(state, { ...request, profileId: "absent" }, context)).toThrow(
    "profile_unavailable",
  );
  expect(() =>
    adoptNativeSession(state, { ...request, session: { ...native, missing: true } }, context),
  ).toThrow("native_session_missing");
});
it("rejects a profile for a different provider", () => {
  expect(() =>
    adoptNativeSession(state, { ...request, session: { ...native, provider: "claude" } }, context),
  ).toThrow("profile_provider_mismatch");
});
it("reuses a linked thread for the same profile and rejects a competing adoption", () => {
  const next = applyEvents(state, adoptNativeSession(state, request, context).events);
  const repeated = adoptNativeSession(next, { ...request, threadId: "different-id" }, context);
  expect(repeated.events).toEqual([]);
  expect(repeated.result).toMatchObject({ id: "new-thread" });
  next.agent?.push({ id: "other-profile", definitionId: "codex-local", archived: false });
  expect(() =>
    adoptNativeSession(next, { ...request, profileId: "other-profile" }, context),
  ).toThrow("native_session_already_adopted");
});
