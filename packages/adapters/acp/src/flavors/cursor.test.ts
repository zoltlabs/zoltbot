import type { InteractionAnswer } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { cursorFlavor } from "./cursor.js";

const answer: InteractionAnswer = {
  action: "accept",
  by: { kind: "human", id: "user" },
  at: "2026-10-27T00:00:00Z",
};
const question = {
  toolCallId: "tool",
  questions: [
    {
      id: "first",
      prompt: "Same",
      allowMultiple: true,
      options: [
        { id: "a", label: "A (Recommended)" },
        { id: "b", label: "B" },
      ],
    },
    { id: "second", prompt: "Same", options: [{ id: "c", label: "C" }] },
  ],
};
it("preserves native question ids and rejects unsupported free text without fabricating option ids", () => {
  const flavor = cursorFlavor();
  const draft = flavor.mapExtensionRequest?.("cursor/ask_question", question);
  expect(draft?.items.map((i) => i.id)).toEqual(["first", "second"]);
  expect(draft?.items[0]).toMatchObject({
    multi: true,
    allowOther: false,
    options: [
      { id: "a", label: "A", recommended: true },
      { id: "b", label: "B", recommended: false },
    ],
  });
  expect(
    flavor.mapExtensionAnswer?.("cursor/ask_question", question, {
      ...answer,
      answers: { first: { options: ["a", "b"] }, second: { options: ["c"] } },
    }),
  ).toEqual({
    outcome: {
      outcome: "answered",
      answers: [
        { questionId: "first", selectedOptionIds: ["a", "b"] },
        { questionId: "second", selectedOptionIds: ["c"] },
      ],
    },
  });
  expect(() =>
    flavor.mapExtensionAnswer?.("cursor/ask_question", question, {
      ...answer,
      answers: { first: { other: "free" } },
    }),
  ).toThrow("invalid_question_answer");
  expect(() =>
    flavor.mapExtensionAnswer?.("cursor/ask_question", question, {
      ...answer,
      answers: { first: { options: ["fabricated"] } },
    }),
  ).toThrow("invalid_question_answer");
});
it("requires concrete plan content and an explicit offered acceptance", () => {
  const flavor = cursorFlavor();
  const plan = { toolCallId: "plan", plan: "Inspect, change, verify", todos: [] };
  expect(flavor.mapExtensionRequest?.("cursor/create_plan", plan)).toMatchObject({
    type: "plan",
    context: { markdown: plan.plan },
  });
  expect(flavor.mapExtensionAnswer?.("cursor/create_plan", plan, answer)).toEqual({
    outcome: { outcome: "accepted" },
  });
  expect(
    flavor.mapExtensionAnswer?.("cursor/create_plan", plan, {
      ...answer,
      action: "decline",
      feedback: "Revise",
    }),
  ).toEqual({ outcome: { outcome: "rejected", reason: "Revise" } });
  expect(
    flavor.mapExtensionAnswer?.("cursor/create_plan", plan, { ...answer, choice: "invented" }),
  ).toEqual({ outcome: { outcome: "cancelled" } });
  expect(() => flavor.mapExtensionRequest?.("cursor/create_plan", { plan: "" })).toThrow(
    "provider_protocol_error",
  );
});
it("merges todo notifications within one session and keeps other sessions isolated", () => {
  const first = cursorFlavor(),
    second = cursorFlavor();
  first.mapExtensionNotification?.("cursor/update_todos", {
    merge: false,
    todos: [{ id: "one", content: "First", status: "pending" }],
  });
  expect(
    first.mapExtensionNotification?.("cursor/update_todos", {
      merge: true,
      todos: [{ id: "two", content: "Second", status: "completed" }],
    }),
  ).toEqual([
    expect.objectContaining({
      entries: [
        { step: "First", status: "pending" },
        { step: "Second", status: "completed" },
      ],
    }),
  ]);
  expect(
    second.mapExtensionNotification?.("cursor/update_todos", {
      merge: true,
      todos: [{ id: "two", content: "Only", status: "pending" }],
    }),
  ).toEqual([expect.objectContaining({ entries: [{ step: "Only", status: "pending" }] })]);
});
