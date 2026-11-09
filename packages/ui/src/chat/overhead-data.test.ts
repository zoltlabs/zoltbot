import { expect, it } from "vitest";
import { overheadData } from "./overhead-data.js";

const rows = [
  { id: "a", sessionId: "old", turnId: "old-turn", inputTokens: 900, injectedTokens: 90 },
  {
    id: "b",
    sessionId: "current",
    turnId: "first",
    inputTokens: 1000,
    cacheReadTokens: 800,
    injectedTokens: 100,
  },
  {
    id: "c",
    sessionId: "current",
    turnId: "second",
    inputTokens: 500,
    cacheReadTokens: 100,
    injectedTokens: 50,
  },
];
it("separates current turn and session totals and never includes an older session", () => {
  expect(overheadData(rows, "current", "second")).toEqual({
    turn: { injectedTokens: 50, inputTokens: 500, percent: 10, cacheRatio: 0.2 },
    session: { injectedTokens: 150, inputTokens: 1500, percent: 10, cacheRatio: 0.6 },
  });
});
it("leaves partial input and cache data unknown while retaining measured injected totals", () => {
  expect(
    overheadData(
      [...rows, { id: "d", sessionId: "current", turnId: "third", injectedTokens: 20 }],
      "current",
      "third",
    ),
  ).toEqual({
    turn: { injectedTokens: 20 },
    session: { injectedTokens: 170 },
  });
  expect(overheadData(rows, "current", "not-reported").turn).toBeUndefined();
  expect(overheadData(rows, undefined, undefined)).toEqual({});
});
it("does not invent a percentage for zero input or accept invalid cache totals", () => {
  const values = [
    { sessionId: "s", turnId: "t", injectedTokens: 0, inputTokens: 0, cacheReadTokens: 0 },
  ];
  expect(overheadData(values, "s", "t")).toEqual({
    turn: { injectedTokens: 0, inputTokens: 0 },
    session: { injectedTokens: 0, inputTokens: 0 },
  });
  expect(
    overheadData([{ ...values[0], inputTokens: 1, cacheReadTokens: 2 }], "s", "t").turn?.cacheRatio,
  ).toBeUndefined();
});
