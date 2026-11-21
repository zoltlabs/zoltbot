import { describe, expect, it } from "vitest";
import { activityCounts, laterRanked } from "./activity-counts.js";

const ask = (id: string, createdAt: string, threadId = "chat") => ({
  id,
  state: "pending",
  type: "question",
  threadId,
  createdAt,
});

describe("activityCounts", () => {
  it("counts running work and what waits on the owner, naming the oldest request", () => {
    expect(
      activityCounts({
        task: [
          { id: "t1", state: "running" },
          { id: "t2", state: "running" },
          { id: "t3", state: "review" },
          { id: "t4", state: "review", routineOccurrenceId: "o" },
          { id: "t5", state: "done" },
        ],
        interaction: [ask("new", "2"), ask("old", "1"), { ...ask("gone", "0"), state: "answered" }],
      }),
    ).toEqual({ working: 2, needsYou: 3, topId: "old" });
  });

  it("leaves out requests ranked later and requests in muted chats", () => {
    const counts = activityCounts({
      interaction: [ask("a", "1", "quiet"), ask("b", "2"), ask("c", "3")],
      settings: [
        { key: "chat.muted.quiet", value: true },
        { key: "chief.queue", value: { items: { b: { rank: "later" } } } },
      ],
    });
    expect(counts).toEqual({ working: 0, needsYou: 1, topId: "c" });
  });

  it("names no request whose id can't go in a push, and caps the counts", () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ id: `t${i}`, state: "running" }));
    expect(activityCounts({ task: many, interaction: [ask("bad id/1", "1")] })).toEqual({
      working: 999,
      needsYou: 1,
    });
  });

  it("drops a later rank once it has an outcome", () => {
    expect([
      ...laterRanked({ items: { a: { rank: "later" }, b: { rank: "later", outcome: "done" } } }),
    ]).toEqual(["a"]);
  });
});
