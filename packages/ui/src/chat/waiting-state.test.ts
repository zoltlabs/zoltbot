import { expect, it } from "vitest";
import { waitingState } from "./waiting-state.js";

const session = {
  id: "session",
  threadId: "thread",
  state: "running",
  startedAt: "2026-11-01T12:00:00Z",
};
it("distinguishes transport, human decisions and provider waits without promising a resend", () => {
  const entities = {
    session: [{ ...session, runtimeStatus: { state: "rate_limited", resetsAt: "invalid" } }],
    interaction: [{ threadId: "thread", state: "pending" }],
  };
  expect(waitingState(entities, "thread", "offline")?.label).toBe("Waiting for connection");
  expect(waitingState(entities, "thread", "online")?.label).toBe("Needs you");
  expect(waitingState({ session: entities.session }, "thread", "online")).toMatchObject({
    label: "Usage limit reached",
    description: "Try again when your coding tool’s usage limit resets.",
  });
  expect(
    waitingState(
      {
        ...entities,
        item: [{ threadId: "thread", kind: "user", body: { queueState: "uncertain" } }],
      },
      "thread",
      "online",
    ),
  ).toBeUndefined();
});
it("ignores historical provider waits and distinguishes background work from a running turn", () => {
  const old = { ...session, id: "old", runtimeStatus: { state: "rate_limited" } };
  const current = {
    ...session,
    startedAt: "2026-11-02T12:00:00Z",
    state: "ready",
    background: [{ id: "job", description: "Build", state: "running" }],
  };
  expect(waitingState({ session: [old, current] }, "thread", "online")?.label).toBe(
    "Background work in progress",
  );
  expect(
    waitingState(
      { session: [old, current], turn: [{ threadId: "thread", status: "running" }] },
      "thread",
      "online",
    ),
  ).toBeUndefined();
  expect(
    waitingState(
      { session: [{ ...session, state: "closed", runtimeStatus: { state: "reconnecting" } }] },
      "thread",
      "online",
    ),
  ).toBeUndefined();
});
