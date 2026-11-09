import { expect, it } from "vitest";
import {
  cancelQueuedInput,
  claimQueuedInput,
  linkQueuedInputTurn,
  queueHumanInput,
  rejectQueuedInput,
  settleQueuedInput,
} from "./input-queue.js";
import { applyEvents } from "./projectors.js";

const at = "2026-10-28T12:00:00Z";
const human = { commandId: "queue", at, actor: { kind: "human" as const, id: "owner" } };
const runtime = { ...human, commandId: "claim", actor: { kind: "system" as const, id: "runtime" } };
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
    { id: "session", threadId: "thread", state: "ready", capabilities: { steer: "native" } },
  ],
};
const input = [{ type: "text" as const, text: "  Preserve every character\n".repeat(100) }];
const queued = (mode: "queue" | "steer" = "queue") =>
  applyEvents(
    base,
    queueHumanInput(base, { threadId: "thread", input, mode }, "message", human).events,
  );
it("durably queues the exact human blocks with a stable timeline order", () => {
  const state = queued();
  expect(state.item?.[0]).toMatchObject({
    id: "message",
    seq: 1,
    kind: "user",
    body: { queueState: "queued", queueVersion: 1, mode: "queue", input },
  });
  expect(state.thread?.[0]?.lastActivityAt).toBe(at);
  expect(() =>
    queueHumanInput(base, { threadId: "thread", input, mode: "queue" }, "m", runtime),
  ).toThrow("human_input_required");
});
it("claims once and rejects a second claimant without modifying the first attempt", () => {
  const state = queued();
  const next = applyEvents(
    state,
    claimQueuedInput(state, "message", "session", "attempt", runtime).events,
  );
  expect(next.item?.[0]?.body).toMatchObject({
    queueState: "sending",
    attemptId: "attempt",
    sessionId: "session",
    deliveryMode: "queue",
  });
  expect(() => claimQueuedInput(next, "message", "session", "other", runtime)).toThrow(
    "input_not_queued",
  );
});
it("queues unsupported steering until idle and permits native steering in a running session", () => {
  const state = queued("steer");
  const busy = {
    ...state,
    session: [{ ...base.session[0], state: "running" }],
    turn: [{ id: "turn", sessionId: "session", threadId: "thread", status: "running" }],
  };
  expect(claimQueuedInput(busy, "message", "session", "attempt", runtime).result).toMatchObject({
    deliveryMode: "steer",
  });
  const coarse = {
    ...busy,
    session: [{ ...busy.session[0], capabilities: { steer: "queue_only" } }],
  };
  expect(() => claimQueuedInput(coarse, "message", "session", "attempt", runtime)).toThrow(
    "thread_busy",
  );
});
it("fences stale acknowledgements and records uncertain delivery without enabling replay", () => {
  const state = queued();
  const sending = applyEvents(
    state,
    claimQueuedInput(state, "message", "session", "attempt", runtime).events,
  );
  expect(() => settleQueuedInput(sending, "message", "wrong", { state: "sent" }, runtime)).toThrow(
    "input_attempt_conflict",
  );
  const uncertain = applyEvents(
    sending,
    settleQueuedInput(
      sending,
      "message",
      "attempt",
      { state: "uncertain", errorCode: "delivery_uncertain" },
      runtime,
    ).events,
  );
  expect(uncertain.item?.[0]?.body).toMatchObject({ queueState: "uncertain", input });
  expect(() => claimQueuedInput(uncertain, "message", "session", "retry", runtime)).toThrow(
    "input_not_queued",
  );
});
it("links a verified native turn and refuses one from another session", () => {
  const state = queued();
  const sending = {
    ...applyEvents(state, claimQueuedInput(state, "message", "session", "attempt", runtime).events),
    turn: [{ id: "turn", sessionId: "session", threadId: "thread", status: "running" }],
  };
  expect(
    applyEvents(
      sending,
      settleQueuedInput(sending, "message", "attempt", { state: "sent", turnId: "turn" }, runtime)
        .events,
    ).item?.[0],
  ).toMatchObject({ turnId: "turn", body: { queueState: "sent" } });
  expect(() =>
    settleQueuedInput(
      { ...sending, turn: [{ ...sending.turn[0], sessionId: "other" }] },
      "message",
      "attempt",
      { state: "sent", turnId: "turn" },
      runtime,
    ),
  ).toThrow("input_turn_mismatch");
});

it("rejects empty messages and incomplete attachments without changing input", () => {
  expect(() =>
    queueHumanInput(
      base,
      { threadId: "thread", input: [{ type: "text", text: "  " }], mode: "queue" },
      "m",
      human,
    ),
  ).toThrow("empty_input");
  expect(() =>
    queueHumanInput(
      base,
      { threadId: "thread", input: [{ type: "image" }], mode: "queue" },
      "m",
      human,
    ),
  ).toThrow("invalid_attachment");
  expect(() =>
    queueHumanInput(
      { ...base, thread: base.thread.map((row) => ({ ...row, archived: true })) },
      { threadId: "thread", input, mode: "queue" },
      "m",
      human,
    ),
  ).toThrow("thread_unavailable");
});
it("upgrades a legacy queued late answer before dispatch and clears a repaired hold", () => {
  const state = queued();
  const legacy = {
    ...state,
    item: (state.item ?? []).map((item) => ({
      ...item,
      body: {
        input,
        queueState: "queued",
        sourceInteractionId: "expired",
        errorCode: "auth_required",
      },
    })),
  };
  const next = applyEvents(
    legacy,
    claimQueuedInput(legacy, "message", "session", "attempt", runtime).events,
  );
  expect(next.item?.[0]?.body).toMatchObject({
    queueVersion: 1,
    queueState: "sending",
    deliveryMode: "queue",
    sourceInteractionId: "expired",
  });
  expect((next.item?.[0]?.body as Record<string, unknown>).errorCode).toBeUndefined();
});

it("links native start evidence before or after its acknowledgement and fences conflicting proof", () => {
  const state = queued();
  const claimed = {
    ...applyEvents(state, claimQueuedInput(state, "message", "session", "attempt", runtime).events),
    turn: [{ id: "turn", sessionId: "session", threadId: "thread", status: "completed" }],
  };
  for (const source of [
    claimed,
    applyEvents(
      claimed,
      settleQueuedInput(claimed, "message", "attempt", { state: "sent" }, runtime).events,
    ),
  ]) {
    const linked = applyEvents(
      source,
      linkQueuedInputTurn(source, "message", "attempt", "turn", runtime).events,
    );
    expect(linked.item?.[0]).toMatchObject({ turnId: "turn", body: { queueState: "sent", input } });
    expect(linkQueuedInputTurn(linked, "message", "attempt", "turn", runtime).events).toEqual([]);
    expect(() => linkQueuedInputTurn(linked, "message", "other", "turn", runtime)).toThrow(
      "input_attempt_conflict",
    );
    expect(() =>
      linkQueuedInputTurn(
        { ...linked, turn: [{ ...claimed.turn[0], sessionId: "other" }] },
        "message",
        "attempt",
        "turn",
        runtime,
      ),
    ).toThrow("input_turn_mismatch");
  }
});
it("does not use delayed start evidence to silently retry an uncertain or handled input", () => {
  const state = queued();
  const claimed = applyEvents(
    state,
    claimQueuedInput(state, "message", "session", "attempt", runtime).events,
  );
  for (const status of ["uncertain", "handled"] as const) {
    const held = applyEvents(
      claimed,
      settleQueuedInput(claimed, "message", "attempt", { state: status }, runtime).events,
    );
    expect(() => linkQueuedInputTurn(held, "message", "attempt", "turn", runtime)).toThrow(
      "input_attempt_conflict",
    );
  }
});

it("rejects invalid attachments before an attempt while preserving exact durable intent", () => {
  const state = queued();
  const rejected = applyEvents(state, rejectQueuedInput(state, "message", runtime).events);
  expect(rejected.item?.[0]?.body).toMatchObject({
    queueState: "failed",
    errorCode: "invalid_input",
    input: (state.item?.[0]?.body as Record<string, unknown>).input,
  });
  expect(rejected.item?.[0]?.body).not.toHaveProperty("attemptId");
  expect(() => rejectQueuedInput(state, "message", human)).toThrow("system_input_writer_required");
  const sending = applyEvents(
    state,
    claimQueuedInput(state, "message", "session", "attempt", runtime).events,
  );
  expect(() => rejectQueuedInput(sending, "message", runtime)).toThrow("input_not_queued");
});

it("cancels only queued human intent, preserves it in history, and audits the human action", () => {
  const state = queued();
  const next = applyEvents(state, cancelQueuedInput(state, "thread", "message", human).events);
  expect(next.item?.[0]?.body).toMatchObject({
    queueState: "failed",
    errorCode: "cancelled",
    input: (state.item?.[0]?.body as Record<string, unknown>).input,
  });
  expect(next.audit?.[0]).toMatchObject({
    action: "turn.cancelQueued",
    actor: human.actor,
    target: "message",
  });
  expect(() => claimQueuedInput(next, "message", "session", "attempt", runtime)).toThrow(
    "input_not_queued",
  );
  expect(() => cancelQueuedInput(state, "other", "message", human)).toThrow(
    "input_thread_conflict",
  );
  expect(() => cancelQueuedInput(state, "thread", "message", runtime)).toThrow(
    "human_input_required",
  );
  const claimed = applyEvents(
    state,
    claimQueuedInput(state, "message", "session", "attempt", runtime).events,
  );
  expect(() => cancelQueuedInput(claimed, "thread", "message", human)).toThrow("input_not_queued");
});

it("keeps per-message Output metadata through durable queue claiming without altering human text", () => {
  const state = applyEvents(
    base,
    queueHumanInput(
      base,
      { threadId: "thread", input, mode: "queue", outputMode: "page" },
      "output-message",
      human,
    ).events,
  );
  expect(state.item?.[0]?.body).toMatchObject({ input, outputMode: "page" });
  const claimed = applyEvents(
    state,
    claimQueuedInput(state, "output-message", "session", "attempt", runtime).events,
  );
  expect(claimed.item?.[0]?.body).toMatchObject({
    input,
    outputMode: "page",
    queueState: "sending",
  });
});

it("preserves exact artifact targets through queue claims and rejects steering targets", () => {
  const artifactTarget = { artifactId: "artifact", versionId: "version-old" };
  const state = applyEvents(
    base,
    queueHumanInput(
      base,
      { threadId: "thread", input, mode: "queue", artifactTarget },
      "targeted",
      human,
    ).events,
  );
  const claimed = applyEvents(
    state,
    claimQueuedInput(state, "targeted", "session", "attempt", runtime).events,
  );
  expect(claimed.item?.[0]?.body).toMatchObject({ artifactTarget, deliveryMode: "queue" });
  expect(() =>
    queueHumanInput(
      base,
      { threadId: "thread", input, mode: "steer", artifactTarget },
      "bad",
      human,
    ),
  ).toThrow("artifact_target_queue_required");
  const forged = {
    ...state,
    item: (state.item ?? []).map((row) => ({
      ...row,
      body: { ...(row.body as object), mode: "steer" },
    })),
  };
  expect(() => claimQueuedInput(forged, "targeted", "session", "attempt", runtime)).toThrow(
    "artifact_target_queue_required",
  );
});
