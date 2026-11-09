import { expect, it } from "vitest";
import { applyEvents } from "./projectors.js";
import { recordUsage } from "./usage-ledger.js";

const at = "2026-10-28T12:00:00Z";
const context = { commandId: "usage", at, actor: { kind: "system" as const, id: "runtime" } };
const base = {
  thread: [{ id: "thread", agentId: "profile", projectId: "project", taskId: "task" }],
  session: [{ id: "session", threadId: "thread" }],
  turn: [{ id: "turn", sessionId: "session", threadId: "thread", startedAt: at }],
};
it("updates a stable per turn record instead of double counting repeated totals", () => {
  const input = {
    sessionId: "session",
    turnId: "turn",
    injectedTokens: 40,
    sample: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      costUsd: 0.2,
      cumulative: false,
    },
  };
  const first = applyEvents(base, recordUsage(base, input, context).events);
  const second = applyEvents(
    first,
    recordUsage(first, input, { ...context, commandId: "repeat" }).events,
  );
  expect(second.usage).toHaveLength(1);
  expect(second.usage?.[0]).toMatchObject({
    id: "turn",
    sessionId: "session",
    turnId: "turn",
    taskId: "task",
    projectId: "project",
    inputTokens: 100,
    costUsd: 0.2,
    costKnown: true,
    injectedTokens: 40,
  });
});
it("reconciles cumulative session totals against a known baseline and earlier turns", () => {
  const first = applyEvents(
    base,
    recordUsage(
      base,
      { sessionId: "session", turnId: "turn", sample: { inputTokens: 100, costUsd: 0.2 } },
      context,
    ).events,
  );
  const next = {
    ...first,
    turn: [
      ...(first.turn ?? []),
      { id: "next", sessionId: "session", threadId: "thread", startedAt: at },
    ],
  };
  const result = recordUsage(
    next,
    {
      sessionId: "session",
      turnId: "next",
      baseline: { inputTokens: 1000, costUsd: 4 },
      sample: { inputTokens: 1250, costUsd: 4.5, cumulative: true },
    },
    context,
  );
  expect(applyEvents(next, result.events).usage?.find((row) => row.id === "next")).toMatchObject({
    inputTokens: 150,
    costUsd: 0.3,
    costKnown: true,
  });
});
it("does not attribute unknown native history to a new turn and flags reset counters", () => {
  const unknown = recordUsage(
    base,
    {
      sessionId: "session",
      turnId: "turn",
      sample: { inputTokens: 5000, costUsd: 10, cumulative: true },
    },
    context,
  );
  expect(unknown.result).toMatchObject({ record: { costKnown: false } });
  expect((unknown.result.record as Record<string, unknown>).costUsd).toBeUndefined();
  const reset = recordUsage(
    base,
    {
      sessionId: "session",
      turnId: "turn",
      baseline: { inputTokens: 100 },
      sample: { inputTokens: 10, cumulative: true },
    },
    context,
  );
  expect(reset.result).toMatchObject({ counterReset: true, record: { costKnown: false } });
});
it("fences session ownership and rejects invalid injection counts or an agent writer", () => {
  const input = { sessionId: "other", turnId: "turn", sample: {} };
  expect(() => recordUsage(base, input, context)).toThrow("usage_session_mismatch");
  expect(() =>
    recordUsage(base, { ...input, sessionId: "session", injectedTokens: -1 }, context),
  ).toThrow("invalid_injected_tokens");
  expect(() =>
    recordUsage(
      base,
      { ...input, sessionId: "session" },
      { ...context, actor: { kind: "agent", id: "profile" } },
    ),
  ).toThrow("system_usage_writer_required");
});
it("does not treat an earlier turn with no usage record as free work", () => {
  const state = {
    ...base,
    turn: [
      { id: "earlier", sessionId: "session", threadId: "thread", startedAt: at },
      ...base.turn,
    ],
  };
  const own = applyEvents(
    state,
    recordUsage(
      state,
      { sessionId: "session", turnId: "turn", sample: { inputTokens: 10, costUsd: 0.001 } },
      context,
    ).events,
  );
  const outcome = recordUsage(
    own,
    {
      sessionId: "session",
      turnId: "turn",
      baseline: { inputTokens: 0, costUsd: 0 },
      sample: { inputTokens: 30, costUsd: 0.003, cumulative: true },
    },
    context,
  );
  expect(outcome.result.record).toMatchObject({ inputTokens: 10, costUsd: 0.001, costKnown: true });
});
