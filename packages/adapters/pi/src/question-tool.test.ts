import { expect, it } from "vitest";
import {
  type GateContext,
  type QuestionToolDefinition,
  registerQuestionTool,
} from "./extension.js";

function tool() {
  let registered: QuestionToolDefinition | undefined;
  registerQuestionTool({
    registerTool(value) {
      registered = value;
    },
  });
  if (!registered) throw new Error("question_tool_missing");
  return registered;
}
const context = (
  select: GateContext["ui"]["select"],
  input: GateContext["ui"]["input"],
): GateContext => ({
  hasUI: true,
  ui: { confirm: async () => false, notify() {}, select, input },
});

it("registers a model-callable question and uses the native select and input routes", async () => {
  const question = tool();
  expect(question.name).toBe("zoltbot_ask_human");
  const calls: unknown[] = [];
  const ctx = context(
    async (title, options) => {
      calls.push({ title, options });
      return "Second";
    },
    async (title, placeholder) => {
      calls.push({ title, placeholder });
      return "Typed answer";
    },
  );
  const select = await question.execute(
    "call",
    { question: "Choose", options: ["First", "Second"] },
    undefined,
    undefined,
    ctx,
  );
  expect(JSON.parse(select.content[0]?.text ?? "")).toEqual({
    status: "answered",
    answer: "Second",
  });
  const input = await question.execute(
    "call",
    { question: "Type answer" },
    undefined,
    undefined,
    ctx,
  );
  expect(JSON.parse(input.content[0]?.text ?? "")).toEqual({
    status: "answered",
    answer: "Typed answer",
  });
  expect(calls).toEqual([
    { title: "Choose", options: ["First", "Second"] },
    { title: "Type answer", placeholder: "" },
  ]);
});

it("reports cancellation when the human skips or the UI is unavailable", async () => {
  const question = tool();
  const ctx = context(
    async () => undefined,
    async () => undefined,
  );
  for (const params of [{ question: "Choose", options: ["First"] }, { question: "Type answer" }]) {
    expect((await question.execute("call", params, undefined, undefined, ctx)).details.status).toBe(
      "cancelled",
    );
    expect(
      (await question.execute("call", params, undefined, undefined, { ...ctx, hasUI: false }))
        .details.status,
    ).toBe("cancelled");
  }
});

it("rejects malformed requests and unreported native selections without echoing values", async () => {
  const question = tool();
  const ctx = context(
    async () => "unreported",
    async () => "answer",
  );
  for (const params of [
    {},
    { question: "x".repeat(2001) },
    { question: "Choose", options: [] },
    { question: "Choose", options: Array(9).fill("option") },
    { question: "Choose", unexpected: "private-value" },
  ])
    await expect(question.execute("call", params, undefined, undefined, ctx)).rejects.toThrow(
      "invalid_question_request",
    );
  await expect(
    question.execute("call", { question: "Choose", options: ["First"] }, undefined, undefined, ctx),
  ).rejects.toThrow("invalid_question_answer");
});

it("passes native abort authority into a pending dialog and returns cancellation", async () => {
  const question = tool();
  const abort = new AbortController();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ctx = context(
    async (_title, _options, opts) => {
      expect(opts?.signal).toBe(abort.signal);
      started();
      return new Promise((resolve) =>
        opts?.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
      );
    },
    async () => {
      throw new Error("unexpected_input");
    },
  );
  const pending = question.execute(
    "call",
    { question: "Choose", options: ["First"] },
    abort.signal,
    undefined,
    ctx,
  );
  await ready;
  abort.abort();
  expect((await pending).details.status).toBe("cancelled");
});

it("replays successful and cancelled execution of the actual bundled tool in the isolated Pi runtime", async () => {
  const { readFileSync } = await import("node:fs");
  const records = readFileSync("fixtures/pi/1.4.0/bundled-questions-no-auth.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const notices = records
    .filter((row) => row.message.type === "extension_ui_request" && row.message.method === "notify")
    .map((row) => JSON.parse(row.message.message));
  expect(notices).toEqual([
    {
      selected: { status: "answered", answer: "Second" },
      input: { status: "answered", answer: "Synthetic answer" },
    },
    { selected: { status: "cancelled" }, input: { status: "cancelled" } },
  ]);
  const stats = records.filter((row) => row.message.command === "get_session_stats");
  expect(stats).toHaveLength(2);
  expect(
    stats.every(
      (row) =>
        row.message.data.totalMessages === 0 &&
        row.message.data.cost === 0 &&
        row.message.data.tokens.total === 0,
    ),
  ).toBe(true);
});
