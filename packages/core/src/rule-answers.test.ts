import { expect, it } from "vitest";
import { applyEvents } from "./projectors.js";
import { applyRuleAnswer } from "./rule-answers.js";

const at = "2026-10-28T12:00:00.000Z";
const context = { commandId: "auto", at, actor: { kind: "system" as const, id: "rules" } };
const rule = {
  id: "rule",
  scope: "global",
  matcher: { tool: "Bash", command: { prefix: ["git", "status"] } },
  decision: "allow",
  createdBy: { kind: "human", id: "owner" },
  createdAt: at,
};
const interaction = {
  id: "request",
  agentId: "profile",
  threadId: "thread",
  type: "approval",
  state: "pending",
  version: 1,
  chain: [],
  urgency: "blocking",
  createdAt: at,
  context: { toolName: "Bash", command: "git status --short" },
  items: [{ id: "a", prompt: "Allow?", choices: [{ id: "allow_once" }, { id: "reject_once" }] }],
};
const state = {
  thread: [{ id: "thread", agentId: "profile" }],
  rule: [rule],
  interaction: [interaction],
};
it("atomically answers and audits the selected rule as a system action", () => {
  const outcome = applyRuleAnswer(state, "request", context);
  const next = applyEvents(state, outcome.events);
  expect(next.interaction?.[0]).toMatchObject({
    state: "answered",
    version: 2,
    resolution: { action: "accept", choice: "allow_once", automatic: true, by: context.actor },
  });
  expect(next.audit?.[0]).toMatchObject({
    action: "interaction.answer",
    detail: { ruleId: "rule", confirmed: false },
  });
  expect(outcome.result).toMatchObject({ matched: true, ruleId: "rule" });
});
it("revocation and compound commands keep the next request pending", () => {
  for (const next of [
    { ...state, rule: [{ ...rule, revokedAt: at }] },
    {
      ...state,
      interaction: [
        { ...interaction, context: { toolName: "Bash", command: "git status | echo unsafe" } },
      ],
    },
    { ...state, interaction: [{ ...interaction, type: "question" }] },
  ])
    expect(applyRuleAnswer(next, "request", context)).toEqual({
      events: [],
      result: { matched: false },
    });
  expect(() =>
    applyRuleAnswer(state, "request", { ...context, actor: { kind: "agent", id: "profile" } }),
  ).toThrow("system_rule_answer_required");
});
it("uses a matching deny rule and never auto answers private approvals", () => {
  const denied = applyRuleAnswer(
    { ...state, rule: [{ ...rule, decision: "deny" }] },
    "request",
    context,
  );
  expect(applyEvents(state, denied.events).interaction?.[0]).toMatchObject({
    resolution: { action: "decline", automatic: true },
  });
  expect(
    applyRuleAnswer(
      {
        ...state,
        interaction: [
          { ...interaction, items: [{ id: "private", prompt: "Private", secret: true }] },
        ],
      },
      "request",
      context,
    ).events,
  ).toEqual([]);
});

it("requires daemon path evidence for every target before automatically allowing an edit", () => {
  const edits = {
    ...state,
    rule: [{ ...rule, matcher: { tool: "Write", kind: "edit", paths: ["src/**"] } }],
    interaction: [
      {
        ...interaction,
        context: { toolName: "Write", toolKind: "edit", paths: ["/work/src/a.ts"] },
      },
    ],
  };
  expect(applyRuleAnswer(edits, "request", context).result.matched).toBe(false);
  expect(applyRuleAnswer(edits, "request", context, ["src/a.ts"]).result.matched).toBe(true);
  for (const paths of [[], ["src/a.ts", "src/b.ts"], ["../outside/a.ts"], ["other/a.ts"]])
    expect(applyRuleAnswer(edits, "request", context, paths).result.matched).toBe(false);
  expect(
    applyRuleAnswer(
      {
        ...edits,
        interaction: [
          { ...interaction, context: { toolName: "Write", paths: ["/work/src/a.ts"] } },
        ],
      },
      "request",
      context,
      ["src/a.ts"],
    ).result.matched,
  ).toBe(false);
});

it("keeps a verified path request pending after its allow rule is revoked", () => {
  const edits = {
    ...state,
    rule: [{ ...rule, matcher: { tool: "Write", kind: "edit", paths: ["src/**"] }, revokedAt: at }],
    interaction: [
      {
        ...interaction,
        context: { toolName: "Write", toolKind: "edit", paths: ["/work/src/a.ts"] },
      },
    ],
  };
  expect(applyRuleAnswer(edits, "request", context, ["src/a.ts"]).result.matched).toBe(false);
});
it("answers allow rules with allow_once even when wider choices are offered", () => {
  const labelled = {
    ...interaction,
    context: {
      ...interaction.context,
      ruleSuggestion: { tool: "Bash", command: { prefix: ["git", "status"] } },
    },
    items: [
      {
        id: "a",
        prompt: "Allow?",
        choices: [
          { id: "allow_once", label: "Bash(git status)" },
          { id: "allow_accept_edits" },
          { id: "reject_once" },
        ],
      },
    ],
  };
  const outcome = applyRuleAnswer({ ...state, interaction: [labelled] }, "request", context);
  expect(applyEvents(state, outcome.events).interaction?.[0]?.resolution).toMatchObject({
    action: "accept",
    choice: "allow_once",
  });
  expect(
    applyRuleAnswer(
      {
        ...state,
        interaction: [
          {
            ...labelled,
            items: [{ id: "a", prompt: "Allow?", choices: [{ id: "allow_accept_edits" }] }],
          },
        ],
      },
      "request",
      context,
    ),
  ).toEqual({ events: [], result: { matched: false } });
});
