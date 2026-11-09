import { readFileSync } from "node:fs";
import type { InteractionAnswer } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { piQuestion } from "./questions.js";

const records = readFileSync("fixtures/pi/1.4.0/questions-no-auth.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const dialogs = records.filter(
  (row) =>
    row.direction === "stdout" &&
    row.message.type === "extension_ui_request" &&
    ["select", "input"].includes(row.message.method),
);
const ids = { id: "interaction", agentId: "profile", threadId: "thread", turnId: "turn" };
const answer: InteractionAnswer = {
  action: "accept",
  by: { kind: "human", id: "human" },
  at: "2026-10-28T00:00:00.000Z",
};

it("replays real Pi select and input dialogs with exact native values and cancellation", () => {
  expect(dialogs).toHaveLength(4);
  const select = piQuestion(dialogs[0].message, ids);
  expect(select.interaction.items[0]).toMatchObject({
    id: "question",
    prompt: "Choose synthetic option",
    multi: false,
    allowOther: false,
    options: [
      { id: "0", label: "First" },
      { id: "1", label: "Second" },
    ],
  });
  expect(select.reply({ ...answer, answers: { question: { options: ["1"] } } })).toEqual({
    value: "Second",
  });
  const input = piQuestion(dialogs[1].message, { ...ids, id: "second-interaction" });
  expect(input.interaction.items[0]).toMatchObject({ prompt: "Synthetic input", allowOther: true });
  expect(input.reply({ ...answer, answers: { question: { other: "Synthetic answer" } } })).toEqual({
    value: "Synthetic answer",
  });
  for (const dialog of dialogs.slice(2))
    expect(piQuestion(dialog.message, ids).reply({ ...answer, action: "cancel" })).toEqual({
      cancelled: true,
    });
  const stats = records.filter((row) => row.message.command === "get_session_stats");
  expect(stats).toHaveLength(2);
  expect(
    stats.every(
      (row) =>
        row.message.data.cost === 0 &&
        row.message.data.tokens.total === 0 &&
        row.message.data.totalMessages === 0,
    ),
  ).toBe(true);
});

it("rejects unsupported selections and free text before consuming a native question", () => {
  const select = piQuestion(dialogs[0].message, ids);
  for (const value of [
    { options: ["missing"] },
    { options: ["0", "1"] },
    { other: "unreported" },
    {},
  ])
    expect(() => select.reply({ ...answer, answers: { question: value } })).toThrow(
      "invalid_question_answer",
    );
  const input = piQuestion(dialogs[1].message, ids);
  expect(() => input.reply({ ...answer, answers: { question: { other: " " } } })).toThrow(
    "invalid_question_answer",
  );
  expect(() => input.reply({ ...answer, answers: { wrong: { other: "answer" } } })).toThrow(
    "invalid_question_answer",
  );
});

it("keeps duplicate labels independent and rejects malformed or oversized native dialogs", () => {
  const select = piQuestion({ ...dialogs[0].message, options: ["Same", "Same"] }, ids);
  expect(select.interaction.items[0]?.options?.map((option) => option.id)).toEqual(["0", "1"]);
  expect(select.reply({ ...answer, answers: { question: { options: ["1"] } } })).toEqual({
    value: "Same",
  });
  for (const options of [[], Array(9).fill("option"), [42]])
    expect(() => piQuestion({ ...dialogs[0].message, options }, ids)).toThrow(
      "invalid_native_question",
    );
  expect(() => piQuestion({ ...dialogs[1].message, title: "x".repeat(2001) }, ids)).toThrow(
    "invalid_native_question",
  );
});
