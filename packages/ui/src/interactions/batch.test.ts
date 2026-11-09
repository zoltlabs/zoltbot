import type { Interaction } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { describeAnswer, recommendedAnswer } from "./batch.js";

const question: Interaction = {
  id: "question",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  state: "pending",
  version: 1,
  urgency: "blocking",
  chain: [],
  createdAt: "2026-10-28T12:00:00Z",
  items: [
    {
      id: "first",
      prompt: "Same prompt",
      options: [
        { id: "a", label: "A", recommended: true },
        { id: "b", label: "B" },
      ],
    },
    {
      id: "second",
      prompt: "Same prompt",
      multi: true,
      options: [
        { id: "c", label: "C", recommended: true },
        { id: "d", label: "D", recommended: true },
      ],
    },
  ],
};
it("builds complete recommended question answers by item identity", () => {
  expect(recommendedAnswer(question)).toEqual({
    action: "accept",
    answers: { first: { options: ["a"] }, second: { options: ["c", "d"] } },
  });
  expect(question.items[0]?.options?.[0]?.recommended).toBe(true);
});
it.each([
  { ...question, state: "expired" },
  { ...question, type: "plan" },
  { ...question, type: "approval" },
  { ...question, type: "form" },
  { ...question, items: [] },
  { ...question, items: [{ ...question.items[0], secret: true }] },
  { ...question, items: [{ id: "missing", prompt: "Write a note", allowOther: true }] },
  { ...question, items: [{ ...question.items[1], multi: false }] },
] as Interaction[])("requires a complete unambiguous public recommendation for every question item: %#", (request) => {
  expect(recommendedAnswer(request)).toBeUndefined();
});

const approval = {
  ...question,
  id: "approval",
  type: "approval",
  items: [
    {
      id: "run",
      prompt: "Run pnpm test",
      choices: [
        { id: "allow_once", label: "Allow once" },
        { id: "reject_once", label: "Reject" },
      ],
    },
  ],
} as Interaction;
const single = { ...question, items: [question.items[0]] } as Interaction;
it("sends Zolt's recommendation as it would relay it", () => {
  expect(recommendedAnswer(approval, { decision: "approve" })).toEqual({
    action: "accept",
    choice: "allow_once",
  });
  expect(recommendedAnswer(approval, { decision: "decline", text: "Not on main" })).toEqual({
    action: "decline",
    feedback: "Not on main",
  });
  expect(recommendedAnswer(approval, { decision: "answer" })).toBeUndefined();
  // Zolt's choice wins over the request's own recommended option.
  expect(recommendedAnswer(single, { decision: "answer", choice: "b" })).toEqual({
    action: "accept",
    answers: { first: { options: ["b"] } },
  });
  expect(recommendedAnswer(single, { decision: "answer", choice: "zz" })).toBeUndefined();
  expect(recommendedAnswer(single, { decision: "answer", text: "C" })).toBeUndefined();
  expect(
    recommendedAnswer(
      { ...single, items: [{ id: "free", prompt: "Which branch?", allowOther: true }] },
      { decision: "answer", text: "release" },
    ),
  ).toEqual({ action: "accept", answers: { free: { other: "release" } } });
  // Questions with several items are answered by hand, unless they carry their own picks.
  expect(recommendedAnswer(question, { decision: "answer", choice: "a" })).toBeUndefined();
});
it("describes answers in a few words for review", () => {
  expect(describeAnswer(approval, { action: "accept", choice: "allow_once" })).toBe("Approve once");
  expect(describeAnswer(approval, { action: "decline", feedback: "later" })).toBe(
    'Decline, saying "later"',
  );
  expect(
    describeAnswer(question, {
      action: "accept",
      answers: { first: { options: ["a"] }, second: { options: ["c", "d"] } },
    }),
  ).toBe("A · C, D");
});
