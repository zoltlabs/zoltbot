import { Value } from "@sinclair/typebox/value";
import { type Interaction, ResolutionSchema } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import {
  answerError,
  answerSummary,
  approvalAnswer,
  approvalButtons,
  chooseOption,
  diffTotals,
  diffView,
  fieldText,
  fieldValue,
  formAnswer,
  formDefaults,
  formFields,
  formSupported,
  formValid,
  type InteractionItem,
  initialAnswers,
  pendingFor,
  planAnswer,
  questionAnswer,
  readField,
  setField,
  singleFlight,
  typeOther,
} from "./interactions.js";
import { sampleSnapshot } from "./sample.js";

const single: InteractionItem = {
  id: "q1",
  prompt: "Which database?",
  options: [
    { id: "pg", label: "Postgres", recommended: true },
    { id: "sqlite", label: "SQLite" },
  ],
};
const multi: InteractionItem = {
  id: "q2",
  prompt: "Which checks?",
  multi: true,
  options: [
    { id: "lint", label: "Lint", recommended: true },
    { id: "test", label: "Tests", recommended: true },
    { id: "types", label: "Types" },
  ],
};
const secret: InteractionItem = { id: "q3", prompt: "API key?", secret: true };
const valid = (draft: object) =>
  Value.Check(ResolutionSchema, {
    ...draft,
    by: { kind: "human", id: "me" },
    at: "2026-11-05T00:00:00.000Z",
  });

describe("question answers", () => {
  it("preselects recommended options with radio and checkbox semantics", () => {
    const answers = initialAnswers([single, multi, secret]);
    expect(answers).toEqual({
      q1: { options: ["pg"] },
      q2: { options: ["lint", "test"] },
      q3: { options: [] },
    });
    expect(chooseOption(single, { options: ["pg"], other: "x" }, "sqlite")).toEqual({
      options: ["sqlite"],
    });
    expect(chooseOption(multi, { options: ["lint", "test"] }, "lint")).toEqual({
      options: ["test"],
    });
    expect(chooseOption(multi, { options: ["test"], other: "x" }, "types")).toEqual({
      options: ["test", "types"],
      other: "x",
    });
  });
  it("replaces a single choice with typed text and keeps secrets out of summaries", () => {
    expect(typeOther(single, { options: ["pg"] }, "MySQL")).toEqual({ other: "MySQL" });
    expect(typeOther(multi, { options: ["lint"] }, "e2e")).toEqual({
      options: ["lint"],
      other: "e2e",
    });
    expect(typeOther(secret, {}, "sk-123")).toEqual({ value: "sk-123" });
    expect(answerSummary(multi, { options: ["lint", "types"], other: "e2e" })).toBe(
      "Lint, Types, e2e",
    );
    expect(answerSummary(secret, { value: "sk-123" })).toBe("Private answer provided");
    expect(answerSummary(single, {})).toBe("No answer");
  });
  it("builds a clean protocol answer", () => {
    const draft = questionAnswer([single, multi, secret], {
      q1: { other: "  MySQL  " },
      q2: { options: ["lint"], other: " " },
      q3: { value: "sk-123" },
    });
    expect(draft).toEqual({
      action: "accept",
      answers: { q1: { other: "MySQL" }, q2: { options: ["lint"] }, q3: { value: "sk-123" } },
    });
    expect(valid(draft)).toBe(true);
  });
});

describe("approval and plan answers", () => {
  const approval = {
    items: [
      {
        id: "a",
        prompt: "Run?",
        choices: [
          { id: "allow_once" as const },
          { id: "allow_session" as const, label: "Bash(npm test:*)" },
          { id: "reject_once" as const },
        ],
      },
    ],
  };
  it("offers only the choices the request allows, with native labels", () => {
    expect(approvalButtons(approval)).toEqual({
      allowOnce: true,
      allowSession: true,
      sessionLabel: "Allow for session: Bash(npm test:*)",
      acceptEdits: false,
    });
    expect(
      approvalButtons({ items: [{ id: "a", prompt: "", choices: [{ id: "reject_once" }] }] }),
    ).toMatchObject({ allowOnce: false, allowSession: false });
    expect(approvalAnswer("allow_session")).toEqual({ action: "accept", choice: "allow_session" });
    expect(approvalAnswer("deny", "  use pnpm  ")).toEqual({
      action: "decline",
      choice: "reject_once",
      feedback: "use pnpm",
    });
    expect(valid(approvalAnswer("deny", "why"))).toBe(true);
  });
  it("maps the plan buttons to choices and feedback", () => {
    const plan = {
      items: [
        {
          id: "p",
          prompt: "Approve?",
          choices: [
            { id: "allow_accept_edits" as const },
            { id: "allow_once" as const },
            { id: "reject_once" as const },
          ],
        },
      ],
    };
    expect(approvalButtons(plan).acceptEdits).toBe(true);
    expect(planAnswer("approve_edits", plan, "")).toEqual({
      action: "accept",
      choice: "allow_accept_edits",
    });
    expect(planAnswer("approve", plan, " ship it ")).toEqual({
      action: "accept",
      choice: "allow_once",
      feedback: "ship it",
    });
    expect(planAnswer("keep_planning", plan, "split step 2")).toEqual({
      action: "decline",
      feedback: "split step 2",
    });
    expect(planAnswer("reject", plan, "")).toEqual({ action: "decline", choice: "reject_once" });
    expect(planAnswer("approve", { items: [{ id: "p", prompt: "" }] }, "")).toEqual({
      action: "accept",
    });
  });
  it("lists a thread's pending requests and explains failures", () => {
    const snapshot = sampleSnapshot(Date.parse("2026-11-03T12:00:00.000Z"));
    expect(pendingFor(snapshot, "thread-unit-settings").map((row) => row.type)).toEqual(["plan"]);
    expect(pendingFor(snapshot, "thread-dark-mode")).toEqual([]);
    expect(answerError(new Error("interaction_conflict"))).toMatch(/answered on another device/);
    expect(answerError(new Error("Your Mac is offline."))).toBe(
      "Your Mac is offline. Your answer was not sent.",
    );
    expect(answerError(new Error("boom"))).toMatch(/draft is kept/);
  });
});

it("lets only one answer through at a time", () => {
  const flight = singleFlight();
  expect(flight.enter()).toBe(true);
  expect(flight.enter()).toBe(false);
  flight.leave();
  expect(flight.enter()).toBe(true);
});

describe("diffs", () => {
  it("colors patch lines and counts them", () => {
    const view = diffView({
      path: "a.ts",
      patch: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n+more\n same",
    });
    expect(view.lines.map((line) => line.type)).toEqual([
      "hunk",
      "hunk",
      "hunk",
      "del",
      "add",
      "add",
      "context",
    ]);
    expect([view.added, view.removed]).toEqual([2, 1]);
    expect(diffView({ path: "b.ts", before: "x", after: "y\nz" })).toMatchObject({
      added: 2,
      removed: 1,
    });
    expect(
      diffTotals([
        { path: "a", patch: "+a\n-b" },
        { path: "c", after: "c" },
      ]),
    ).toEqual({
      files: 2,
      added: 2,
      removed: 1,
    });
  });
});

describe("forms", () => {
  const form: InteractionItem = {
    id: "f",
    prompt: "Project details",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name", minLength: 1 },
        count: { type: "integer", default: 2 },
        mode: { enum: ["safe", "fast"] },
        public: { type: "boolean" },
      },
      required: ["name", "mode"],
    },
  };
  it("reads flat schemas into fields with defaults", () => {
    expect(formSupported(form)).toBe(true);
    expect(formFields(form).map((field) => [field.id, field.type, field.required])).toEqual([
      ["name", "string", true],
      ["count", "integer", false],
      ["mode", "enum", true],
      ["public", "boolean", false],
    ]);
    expect(formDefaults(form)).toEqual({ count: 2 });
    expect(
      formSupported({
        id: "x",
        prompt: "",
        schema: { type: "object", properties: { a: { type: "object" } } },
      }),
    ).toBe(false);
  });
  it("validates and builds the answer", () => {
    const count = formFields(form)[1];
    if (!count) throw new Error("count field");
    let value = formDefaults(form);
    expect(formValid(form, value)).toBe(false);
    value = setField(form, value, "name", "Zolt");
    value = setField(form, value, "mode", "safe");
    value = setField(form, value, "count", fieldValue(count, ""));
    expect(readField(form, value, "name")).toBe("Zolt");
    expect(value).toEqual({ name: "Zolt", mode: "safe" });
    expect(formValid(form, value)).toBe(true);
    expect(fieldValue(count, "3")).toBe(3);
    // Partial decimals stay editable: the raw text shows while it parses to the stored value.
    const amount = { ...count, type: "number" as const };
    expect(fieldValue(amount, "1.")).toBe(1);
    expect(fieldText(amount, "1.", fieldValue(amount, "1."))).toBe("1.");
    expect(fieldText(amount, "1.5", fieldValue(amount, "1.5"))).toBe("1.5");
    expect(fieldText(amount, "-", fieldValue(amount, "-"))).toBe("-");
    expect(fieldText(amount, "1.", 7)).toBe("7");
    expect(fieldText(amount, undefined, 2)).toBe("2");
    const draft = formAnswer([form], { f: value });
    expect(draft).toEqual({ action: "accept", answers: { f: { value } } });
    expect(valid(draft)).toBe(true);
  });
});

it("typechecks interactions from the sample", () => {
  const snapshot = sampleSnapshot();
  const plan = pendingFor(snapshot, "thread-unit-settings")[0] as Interaction;
  expect(approvalButtons(plan).acceptEdits).toBe(true);
});
