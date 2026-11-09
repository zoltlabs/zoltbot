import { parse, type UsageRecord, UsageRecordSchema } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { analyzeCache, evaluateBudget, summarizeUsage } from "./usage-meter.js";

const record = (
  id: string,
  changes: { [K in keyof UsageRecord]?: UsageRecord[K] | undefined } = {},
): UsageRecord =>
  parse(
    UsageRecordSchema,
    Object.fromEntries(
      Object.entries({
        id,
        sessionId: "session",
        taskId: "task",
        projectId: "project",
        injectedTokens: 20,
        costKnown: true,
        costUsd: 0.25,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        recordedAt: "2026-10-28T12:00:00Z",
        ...changes,
      }).filter(([, value]) => value !== undefined),
    ),
  );
it("aggregates known usage and cache ratios without counting cache reads twice", () => {
  expect(summarizeUsage([record("a"), record("b")])).toMatchObject({
    inputTokens: 200,
    outputTokens: 40,
    injectedTokens: 40,
    knownCostUsd: 0.5,
    costUsd: 0.5,
    costKnown: true,
    cacheRatio: 0.8,
  });
});
it("distinguishes missing and estimated cost from reported zero, and omits incomplete ratios", () => {
  const unknown = record("b", {
    costKnown: false,
    costUsd: undefined,
    inputTokens: undefined,
    cacheReadTokens: undefined,
  });
  const total = summarizeUsage([record("a", { costUsd: 0 }), unknown]);
  expect(total).toMatchObject({ knownCostUsd: 0, costKnown: false, unknownCostRecords: 1 });
  expect(total.costUsd).toBeUndefined();
  expect(total.inputTokens).toBeUndefined();
  expect(total.cacheRatio).toBeUndefined();
  expect(summarizeUsage([record("estimate", { costKnown: false, costUsd: 0.3 })])).toMatchObject({
    estimatedCostUsd: 0.3,
    costKnown: false,
  });
});
it("enforces zero, soft, hard, and unknown budgets with task, project, and UTC day scopes", () => {
  const rows = [
    record("a"),
    record("other", { taskId: "other", projectId: "other", recordedAt: "2026-10-27T12:00:00Z" }),
  ];
  expect(evaluateBudget(rows, { scopeType: "task", scopeId: "task", usd: 0.3 }).status).toBe(
    "soft",
  );
  expect(
    evaluateBudget(rows, { scopeType: "project", scopeId: "project", tokens: 120 }).status,
  ).toBe("hard");
  expect(evaluateBudget(rows, { scopeType: "day", scopeId: "2026-10-28", usd: 1 }).status).toBe(
    "ok",
  );
  expect(evaluateBudget([], { scopeType: "task", scopeId: "new", usd: 0 }).status).toBe("hard");
  expect(
    evaluateBudget([record("unknown", { costKnown: false, costUsd: undefined })], {
      scopeType: "task",
      scopeId: "task",
      usd: 1,
    }).status,
  ).toBe("unknown");
  expect(
    evaluateBudget(
      [record("partial"), record("unknown", { costKnown: false, costUsd: undefined })],
      { scopeType: "task", scopeId: "task", usd: 0.2 },
    ).status,
  ).toBe("hard");
});
it("attributes sharp cache drops and flags three steady low ratios without inventing a cause", () => {
  const turn = { inputTokens: 100, cacheReadTokens: 90, model: "model", toolsHash: "stable" };
  expect(analyzeCache([turn, { ...turn, model: "new", cacheReadTokens: 5 }])).toMatchObject({
    broke: true,
    cause: "model_changed",
    ratio: 0.05,
    diagnostic: false,
  });
  expect(analyzeCache([turn, { ...turn, toolsHash: "changed", cacheReadTokens: 5 }]).cause).toBe(
    "tools_changed",
  );
  const low = { ...turn, cacheReadTokens: 5 };
  expect(analyzeCache([turn, low, low, low])).toMatchObject({ diagnostic: true });
  expect(analyzeCache([turn, low, low, { ...low, compacted: true }])).toMatchObject({
    cause: "compaction",
    diagnostic: false,
  });
  expect(analyzeCache([{ ...turn, cacheReadTokens: undefined }]).ratio).toBeUndefined();
});

it("refuses invalid budget values and never displays an invalid cache ratio", () => {
  for (const usd of [NaN, Infinity, -1])
    expect(() => evaluateBudget([], { scopeType: "task", scopeId: "task", usd })).toThrow(
      "invalid_budget",
    );
  expect(() => evaluateBudget([], { scopeType: "day", scopeId: "2026-99-99", usd: 1 })).toThrow(
    "invalid_budget_day",
  );
  expect(analyzeCache([{ inputTokens: 100, cacheReadTokens: 101 }]).ratio).toBeUndefined();
  expect(analyzeCache([{ inputTokens: NaN, cacheReadTokens: 1 }]).ratio).toBeUndefined();
});
