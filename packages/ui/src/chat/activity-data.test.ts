import { describe, expect, it } from "vitest";
import { artifactTimeline, type TimelineRow } from "../artifacts/occurrences.js";
import {
  activityLabel,
  groupActivity,
  markRecovered,
  runningToolLabel,
  summarizeSteps,
} from "./activity-data.js";
import { body, type Row } from "./types.js";

const tool = (id: string, status = "ok", turnId = "turn"): Row => ({
  id,
  kind: "tool",
  turnId,
  body: { kind: "read", status },
});
const display = (items: Row[]) => artifactTimeline(items, [], []);

it("groups adjacent routine work without swallowing approvals, failures, partial replies or turn boundaries", () => {
  const input = display([
    tool("read"),
    { id: "think", kind: "thought", turnId: "turn", body: { text: "Check it" } },
    tool("failed", "error"),
    tool("denied", "denied"),
    { ...tool("request"), body: { interactive: true, status: "running" } },
    { id: "partial", kind: "thought", body: { partial: true } },
    tool("next"),
    tool("another-turn", "ok", "other"),
    { id: "answer", kind: "message", body: { text: "Done" } },
  ]);
  const rows = groupActivity(input);
  expect(rows.map((row) => row.key)).toEqual([
    "activity:read",
    "message:failed",
    "message:denied",
    "message:request",
    "message:partial",
    "activity:next",
    "activity:another-turn",
    "message:answer",
  ]);
  expect(rows[0]).toMatchObject({ type: "activity", items: [{ id: "read" }, { id: "think" }] });
  expect(input).toHaveLength(9);
});

it("preserves artifact positions and activity keys as steps stream in", () => {
  const artifact: TimelineRow = {
    type: "artifact",
    key: "artifact:turn:a",
    artifact: { id: "a" },
    versions: [],
    turnId: "turn",
  };
  const first = groupActivity(display([tool("read")]));
  const streamed = groupActivity([
    ...display([tool("read"), tool("next", "running")]),
    artifact,
    ...display([tool("after")]),
  ]);
  expect(streamed[0]?.key).toBe(first[0]?.key);
  expect(streamed[1]).toBe(artifact);
  expect(streamed[2]?.key).toBe("activity:after");
});

it("describes only reported activity and gives a compact finished summary", () => {
  expect(activityLabel([tool("1", "running")])).toBe("Reading files…");
  expect(activityLabel([{ id: "2", kind: "thought", body: { streaming: true } }])).toBe(
    "Thinking…",
  );
  expect(activityLabel([tool("1"), tool("2")])).toBe("Read 2 files");
});

it("uses skill progress only for an actual skill tool event", () => {
  expect(runningToolLabel({ kind: "search", name: "skill_search" })).toBe("Checking skills…");
  expect(runningToolLabel({ kind: "search", name: "Search" })).toBe("Searching…");
});

describe("markRecovered", () => {
  const step = (id: string, status: string, command = "pnpm test", turnId = "t1"): Row => ({
    id,
    turnId,
    kind: "tool",
    body: { kind: "execute", title: command, status },
  });
  it("marks a failure fixed when the same step later passes in the same turn", () => {
    const items = markRecovered([step("a", "error"), step("b", "ok")]);
    expect(body(items[0] as Row).recovered).toBe(true);
    expect(summarizeSteps(items)).toBe("Ran 2 commands and fixed 1 failed step");
    const rows = items.map((item) => ({ type: "message", key: String(item.id), item }));
    expect(groupActivity(rows as TimelineRow[])).toHaveLength(1);
  });
  it("leaves failures that were never fixed, or fixed in another turn", () => {
    const items = [
      step("a", "error"),
      step("b", "ok", "pnpm lint"),
      step("c", "ok", "pnpm test", "t2"),
    ];
    expect(markRecovered(items)).toBe(items);
    expect(markRecovered([step("b", "ok"), step("a", "error")])[1]).not.toHaveProperty(
      "body.recovered",
    );
  });
});
