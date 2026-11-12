import { expect, it } from "vitest";
import { artifactTimeline } from "../artifacts/occurrences.js";
import { groupActivity, summarizeSteps } from "./activity-data.js";
import { foldTurns, formatDuration } from "./turn-fold.js";
import type { Row } from "./types.js";

const tool = (id: string, kind: string, extra: Row = {}): Row => ({
  id,
  kind: "tool",
  turnId: "t1",
  body: { kind, status: "ok", ...extra },
});

it("formats durations the way a person reads them", () => {
  expect(formatDuration(850)).toBe("850ms");
  expect(formatDuration(4_240)).toBe("4.2s");
  expect(formatDuration(59_600)).toBe("1m");
  expect(formatDuration(134_000)).toBe("2m 14s");
  expect(formatDuration(3_605_000)).toBe("1h 5s");
});

it("sums a tool group up in one sentence, changes first and the rest counted", () => {
  expect(
    summarizeSteps([
      tool("1", "read", { locations: [{ path: "a.ts" }] }),
      tool("2", "read", { locations: [{ path: "b.ts" }] }),
      tool("3", "read", { locations: [{ path: "a.ts" }] }),
      tool("4", "execute"),
      tool("5", "execute"),
    ]),
  ).toBe("Read 2 files and ran 2 commands");
  expect(
    summarizeSteps([
      tool("1", "search"),
      tool("2", "edit", { diffs: [{ path: "a.ts" }] }),
      tool("3", "execute"),
      tool("4", "fetch"),
    ]),
  ).toBe("Edited 1 file, ran 1 command, and performed 2 other actions");
  expect(summarizeSteps([{ id: "1", kind: "thought", body: {} }])).toBe("Thought");
});

it("folds a finished turn to one line above its answer and keeps what needs attention", () => {
  const items: Row[] = [
    { id: "u", kind: "user", turnId: "t1", body: {} },
    { id: "c", kind: "message", turnId: "t1", body: {} },
    tool("r", "read"),
    { id: "x", kind: "tool", turnId: "t1", body: { kind: "execute", status: "error" } },
    { id: "a", kind: "message", turnId: "t1", phase: "final", body: {} },
    { id: "u2", kind: "user", turnId: "t2", body: {} },
    tool("r2", "read", {}),
  ].map((row) => (row.id === "r2" ? { ...row, turnId: "t2" } : row));
  const rows = groupActivity(artifactTimeline(items, [], []));
  const turns = [
    {
      id: "t1",
      status: "completed",
      startedAt: "2026-11-07T10:00:00Z",
      endedAt: "2026-11-07T10:02:14Z",
    },
    { id: "t2", status: "running", startedAt: "2026-11-07T10:03:00Z" },
  ];
  const folded = foldTurns(rows, turns, new Set());
  expect(folded.map((row) => (row.type === "fold" ? row.label : row.key))).toEqual([
    "message:u",
    "message:c",
    "Worked for 2m 14s",
    "message:x",
    "message:a",
    "message:u2",
    "activity:r2",
  ]);
  const open = foldTurns(rows, turns, new Set(["t1"]));
  expect(open.map((row) => row.key)).toEqual([
    "message:u",
    "message:c",
    "fold:t1",
    "activity:r",
    "message:x",
    "message:a",
    "message:u2",
    "activity:r2",
  ]);
  const stopped = foldTurns(rows, [{ ...turns[0], status: "interrupted" }], new Set());
  expect(stopped.find((row) => row.type === "fold")).toMatchObject({
    label: "You stopped after 2m 14s",
  });
});
