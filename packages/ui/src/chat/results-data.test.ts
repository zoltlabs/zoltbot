import { expect, it } from "vitest";
import { threadResults } from "./results-data.js";

const turn = {
  id: "turn",
  threadId: "thread",
  status: "completed",
  startedAt: "2026-11-01T12:00:00Z",
};
it("only offers completion for settled work, never unanswered, queued or delegated work", () => {
  const base = { turn: [turn] };
  expect(threadResults(base, "thread").complete).toBe(true);
  for (const extra of [
    { interaction: [{ threadId: "thread", state: "pending" }] },
    { item: [{ threadId: "thread", kind: "user", body: { queueState: "uncertain" } }] },
    { session: [{ threadId: "thread", background: [{ state: "running" }] }] },
    {
      task: [
        { id: "parent", threadId: "thread", state: "review" },
        { parentId: "parent", state: "running" },
      ],
    },
    { turn: [{ ...turn, status: "failed" }] },
  ])
    expect(threadResults({ ...base, ...extra }, "thread").complete).toBe(false);
});
it("scopes results to the current revision, latest-turn diffs and explicit safe reply links", () => {
  const data = threadResults(
    {
      turn: [turn],
      task: [{ id: "task", threadId: "thread", revision: 2 }],
      taskResult: [
        { taskId: "task", revision: 1, summary: "old" },
        { taskId: "task", revision: 2, summary: "current" },
      ],
      artifact: [
        { threadId: "other" },
        { id: "archived", threadId: "thread", state: "archived" },
        { id: "visible", threadId: "thread" },
      ],
      item: [
        {
          threadId: "thread",
          kind: "message",
          body: {
            text: "[Preview](https://example.invalid/preview) [Duplicate](https://example.invalid/preview) [Secret](https://user:pass@example.invalid/)",
          },
        },
        {
          threadId: "thread",
          kind: "tool",
          body: { text: "[Not a reply](https://example.invalid/tool)" },
        },
        {
          threadId: "thread",
          turnId: "old",
          kind: "tool",
          body: { kind: "edit", diffs: [{ path: "old.ts", patch: "+old" }] },
        },
        {
          threadId: "thread",
          turnId: "turn",
          kind: "tool",
          body: { kind: "edit", diffs: [{ path: "new.ts", patch: "+new" }] },
        },
      ],
    },
    "thread",
  );
  expect(data.result?.summary).toBe("current");
  expect(data.artifacts.map((row) => row.id)).toEqual(["visible"]);
  expect(data.links).toEqual([{ url: "https://example.invalid/preview", label: "Duplicate" }]);
  expect(data.diffs.map((diff) => diff.path)).toEqual(["new.ts"]);
});
