import { expect, it } from "vitest";
import { requestNativeCompaction, settleNativeCompaction } from "./native-compaction.js";
import { applyEvents } from "./projectors.js";
import { observeRuntimeEvent } from "./runtime-events.js";

const at = "2026-10-28T12:00:00Z";
const human = { commandId: "compact", at, actor: { kind: "human" as const, id: "owner" } };
const system = { ...human, commandId: "settle", actor: { kind: "system" as const, id: "runtime" } };
const base = {
  thread: [{ id: "thread", agentId: "profile", archived: false }],
  session: [
    {
      id: "session",
      threadId: "thread",
      state: "ready",
      capabilities: { compaction: { manual: true, events: true } },
    },
  ],
};
const claim = () => requestNativeCompaction(base, "session", "note", "attempt", human);
it("records the human request and audit before native compaction without storing instructions", () => {
  const outcome = claim(),
    state = applyEvents(base, outcome.events);
  expect(state.item?.[0]).toMatchObject({
    id: "note",
    kind: "note",
    threadId: "thread",
    seq: 1,
    body: {
      code: "manual_compaction",
      state: "sending",
      attemptId: "attempt",
      sessionId: "session",
    },
  });
  expect(state.audit?.[0]).toMatchObject({
    actor: human.actor,
    action: "session.compact",
    target: "session",
    result: "allowed",
  });
  expect(state.turn ?? []).toEqual([]);
  expect(() => requestNativeCompaction(base, "session", "note", "attempt", system)).toThrow(
    "human_compaction_required",
  );
});
it("requires idle native capability and refuses overlapping or uncertain operations", () => {
  expect(() =>
    requestNativeCompaction(
      { ...base, session: [{ ...base.session[0], state: "running" }] },
      "session",
      "n",
      "a",
      human,
    ),
  ).toThrow("compaction_requires_idle");
  expect(() =>
    requestNativeCompaction(
      {
        ...base,
        session: [{ ...base.session[0], capabilities: { compaction: { manual: false } } }],
      },
      "session",
      "n",
      "a",
      human,
    ),
  ).toThrow("unsupported_compaction");
  const state = applyEvents(base, claim().events);
  for (const status of ["sending", "acknowledged", "uncertain"]) {
    const blocked = {
      ...state,
      item:
        state.item?.map((row) => ({
          ...row,
          body: { ...(row.body as Record<string, unknown>), state: status },
        })) ?? [],
    };
    expect(() => requestNativeCompaction(blocked, "session", "next", "other", human)).toThrow(
      "compaction_review_or_wait_required",
    );
  }
});
it("fences stale settlement and separates acknowledgement from observed completion", () => {
  const state = applyEvents(base, claim().events);
  expect(() => settleNativeCompaction(state, "note", "wrong", "acknowledged", system)).toThrow(
    "compaction_attempt_conflict",
  );
  const acknowledged = applyEvents(
    state,
    settleNativeCompaction(state, "note", "attempt", "acknowledged", system).events,
  );
  expect(acknowledged.item?.[0]?.body).toMatchObject({ state: "acknowledged" });
  const observed = applyEvents(
    acknowledged,
    observeRuntimeEvent(
      acknowledged,
      {
        sessionId: "session",
        threadId: "thread",
        itemId: "observed",
        event: { t: "compaction", state: "done", trigger: "manual" },
      },
      system,
    ).events,
  );
  expect(observed.item?.find((row) => row.id === "note")?.body).toMatchObject({
    state: "completed",
    confirmation: "native_event",
  });
  expect(settleNativeCompaction(observed, "note", "attempt", "uncertain", system).events).toEqual(
    [],
  );
});
it("uses acknowledgement only when the native capability does not expose compaction events", () => {
  const state = {
    ...base,
    session: [
      { ...base.session[0], capabilities: { compaction: { manual: true, events: false } } },
    ],
  };
  const claimed = applyEvents(
    state,
    requestNativeCompaction(state, "session", "note", "attempt", human).events,
  );
  expect(
    applyEvents(
      claimed,
      settleNativeCompaction(claimed, "note", "attempt", "acknowledged", system).events,
    ).item?.[0]?.body,
  ).toMatchObject({ state: "completed", confirmation: "native_ack" });
});
