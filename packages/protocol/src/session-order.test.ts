import { expect, it } from "vitest";
import { compareSessions } from "./session-order.js";

it("prefers durable generations over tied or reversed wall clocks and keeps legacy ordering deterministic", () => {
  const rows = [
    { id: "legacy", startedAt: "2099-01-01T00:00:00Z" },
    { id: "first", generation: 1, startedAt: "2026-10-28T12:00:00Z" },
    { id: "second", generation: 2, startedAt: "2026-10-28T11:00:00Z" },
  ];
  expect(rows.sort(compareSessions).map((row) => row.id)).toEqual(["second", "first", "legacy"]);
  expect(
    [
      { id: "a", startedAt: "same" },
      { id: "b", startedAt: "same" },
    ]
      .sort(compareSessions)
      .map((row) => row.id),
  ).toEqual(["b", "a"]);
});
