import { expect, it } from "vitest";
import {
  answerDraft,
  compareAnswers,
  layoutFor,
  readOnlyReason,
  scrollFraction,
  scrollPosition,
} from "./compare-state.js";

it("uses tabs below the layout thresholds and preserves explicit stacked mode", () => {
  expect(layoutFor(1000, 2, "columns")).toBe("tabs");
  expect(layoutFor(1280, 4, "columns")).toBe("tabs");
  expect(layoutFor(1440, 4, "columns")).toBe("columns");
  expect(layoutFor(1000, 4, "stacked")).toBe("stacked");
});
it("synchronizes unequal scroll ranges and clamps overscroll", () => {
  expect(scrollPosition(scrollFraction(200, 1000, 200), 1800, 200)).toBe(400);
  expect(scrollFraction(-10, 100, 200)).toBe(0);
  expect(scrollPosition(2, 1000, 100)).toBe(900);
});
it("fails closed for unknown read-only capabilities", () => {
  expect(readOnlyReason({ definitionId: "a" }, [], true)).toBe("Can't run read-only");
  expect(
    readOnlyReason(
      { definitionId: "a" },
      [{ id: "a", staticCapabilities: { readOnly: true } }],
      true,
    ),
  ).toBe("");
});
it("caps each quoted answer with an explicit visible omission", () => {
  const draft = answerDraft("merge", [{ name: "First", answer: "x".repeat(30000) }]);
  expect(draft).toContain("x".repeat(24000));
  expect(draft).not.toContain("x".repeat(24001));
  expect(draft).toContain("[cut: 6000 more characters, open the full answer]");
});

it("orders member drafts and quotes the last final answer without copying thread history", () => {
  const e = {
    compareMember: [
      { compareId: "c", threadId: "second", position: 1 },
      { compareId: "c", threadId: "first", position: 0 },
    ],
    thread: [
      { id: "first", agentId: "a" },
      { id: "second", agentId: "b" },
    ],
    agent: [
      { id: "a", name: "First" },
      { id: "b", name: "Second" },
    ],
    item: [
      {
        threadId: "first",
        kind: "message",
        phase: "final",
        seq: 2,
        body: { text: "Final answer" },
      },
      { threadId: "first", kind: "message", seq: 3, body: { text: "Streaming later turn" } },
      {
        threadId: "first",
        kind: "message",
        phase: "final",
        seq: 4,
        body: { text: "Nested private answer", parentItemId: "tool" },
      },
      {
        threadId: "first",
        kind: "user",
        seq: 1,
        body: { input: [{ type: "text", text: "Private old chat" }] },
      },
    ],
  };
  const answers = compareAnswers(e, "c");
  expect(answers.map((a) => a.name)).toEqual(["First", "Second"]);
  expect(answers[0]?.answer).toBe("Final answer");
  expect(JSON.stringify(answers)).not.toContain("Private old chat");
  expect(e.compareMember[0]?.threadId).toBe("second");
});

it("does not cut through a Unicode code point in quoted answers", () => {
  const draft = answerDraft("merge", [{ name: "Emoji", answer: "😀".repeat(24001) }]);
  expect(draft).toContain("😀".repeat(24000));
  expect(draft).not.toContain("😀".repeat(24001));
  expect(draft).toContain("[cut: 1 more characters, open the full answer]");
});
