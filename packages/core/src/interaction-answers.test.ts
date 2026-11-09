import { expect, it } from "vitest";
import { handle } from "./commands.js";

const at = "2026-10-27T12:00:00.000Z";
const context = { commandId: "answer", at, actor: { kind: "human" as const, id: "owner" } };
const interaction = {
  id: "question",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  items: [
    {
      id: "one",
      prompt: "Same text",
      allowOther: false,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
    { id: "two", prompt: "Same text" },
  ],
  chain: [],
  urgency: "blocking",
  version: 1,
  state: "pending",
  createdAt: at,
};
function answer(answers: Record<string, { options?: string[]; other?: string }>) {
  return handle(
    { interaction: [interaction] },
    {
      type: "answer",
      id: interaction.id,
      version: 1,
      answer: { action: "accept", answers, by: context.actor, at },
    },
    context,
  );
}
it("uses item IDs so duplicate question text can receive independent answers", () => {
  expect(answer({ one: { options: ["a"] }, two: { other: "Independent" } }).result).toMatchObject({
    state: "answered",
  });
});
it("rejects unknown items, missing answers, invalid options, disabled other, and invalid multi select", () => {
  for (const answers of [
    { one: { options: ["a"] } },
    { one: { options: ["unknown"] }, two: { other: "ok" } },
    { one: { other: "forbidden" }, two: { other: "ok" } },
    { one: { options: ["a", "b"] }, two: { other: "ok" } },
    { one: { options: ["a"] }, two: { other: "ok" }, extra: { other: "unknown" } },
  ])
    expect(() => answer(answers)).toThrow("invalid_interaction_answer");
});
it("does not let an agent impersonate an automatic human answer", () => {
  expect(() =>
    handle(
      { interaction: [interaction] },
      {
        type: "answer",
        id: interaction.id,
        version: 1,
        answer: { action: "cancel", automatic: true, by: { kind: "system", id: "forged" }, at },
      },
      { ...context, actor: { kind: "agent", id: "chief" } },
    ),
  ).toThrow("human_answer_required");
});
it("validates form values before persisting a resolution and permits declining unsupported forms", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, mode: { type: "string", enum: ["safe", "fast"] } },
    required: ["name", "mode"],
  };
  const form = { ...interaction, type: "form", items: [{ id: "form", prompt: "Details", schema }] };
  const submit = (value: unknown) =>
    handle(
      { interaction: [form] },
      {
        type: "answer",
        id: form.id,
        version: 1,
        answer: { action: "accept", answers: { form: { value } }, by: context.actor, at },
      },
      context,
    );
  expect(submit({ name: "Work", mode: "safe" }).result).toMatchObject({ state: "answered" });
  expect(() => submit({ name: "Work", mode: "unknown" })).toThrow("invalid_interaction_answer");
  expect(() => submit({ mode: "safe" })).toThrow("invalid_interaction_answer");
  const unsupported = {
    ...form,
    items: [{ id: "form", prompt: "Details", schema: { $ref: "https://example.invalid/schema" } }],
  };
  expect(() =>
    handle(
      { interaction: [unsupported] },
      {
        type: "answer",
        id: form.id,
        version: 1,
        answer: { action: "accept", answers: { form: { value: {} } }, by: context.actor, at },
      },
      context,
    ),
  ).toThrow("unsupported_form_schema");
  expect(
    handle(
      { interaction: [unsupported] },
      {
        type: "answer",
        id: form.id,
        version: 1,
        answer: { action: "decline", by: context.actor, at },
      },
      context,
    ).result,
  ).toMatchObject({ state: "answered" });
});
it("accepts allow_accept_edits only when the request offers it", () => {
  const request = (type: string, choices: { id: string; label?: string }[] | undefined) => ({
    ...interaction,
    id: type,
    type,
    items: [{ id: "review", prompt: "Approve the plan?", ...(choices ? { choices } : {}) }],
  });
  const submit = (row: Record<string, unknown>, choice?: string) =>
    handle(
      { interaction: [row] },
      {
        type: "answer",
        id: String(row.id),
        version: 1,
        answer: { action: "accept", ...(choice ? { choice } : {}), by: context.actor, at },
      },
      { ...context, commandId: `answer:${String(row.id)}:${choice}` },
    );
  const offered = [
    { id: "allow_once" },
    { id: "allow_accept_edits", label: "Yes, and auto-accept edits" },
    { id: "reject_once" },
  ];
  expect(submit(request("plan", offered), "allow_accept_edits").result).toMatchObject({
    state: "answered",
    resolution: { choice: "allow_accept_edits" },
  });
  expect(submit(request("approval", offered), "allow_accept_edits").result).toMatchObject({
    state: "answered",
  });
  expect(submit(request("plan", undefined)).result).toMatchObject({ state: "answered" });
  for (const [row, choice] of [
    [request("plan", [{ id: "allow_once" }]), "allow_accept_edits"],
    [request("plan", undefined), "allow_accept_edits"],
    [request("approval", [{ id: "allow_once" }, { id: "reject_once" }]), "allow_accept_edits"],
  ] as const)
    expect(() => submit(row, choice)).toThrow("invalid_interaction_answer");
});
