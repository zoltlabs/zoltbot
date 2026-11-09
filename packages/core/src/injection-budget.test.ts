import { expect, it } from "vitest";
import { enforceInjectionBudget } from "./injection-budget.js";

const estimator = (text: string) => text.length;
it("preserves all human text and attachments and appends generated context only at the end", () => {
  const human = [
    { type: "text" as const, text: "Human text\n".repeat(3000) },
    { type: "image" as const, mimeType: "image/png", base64: "synthetic" },
  ];
  const before = structuredClone(human);
  const plan = enforceInjectionBudget({
    estimate: estimator,
    human,
    fragments: [
      { id: "message", kind: "peer", text: "generated".repeat(100), reference: "message:message" },
    ],
    hardCap: 120,
  });
  expect(plan.input.slice(0, human.length)).toEqual(human);
  expect(human).toEqual(before);
  expect(plan.input.at(-1)).toEqual({ type: "text", text: plan.injectedText });
  expect(plan.estimatedTokens).toBeLessThanOrEqual(120);
  expect(plan.shortened).toEqual(["message"]);
});
it("shrinks task context packs first and preserves deterministic order", () => {
  const fragments = [
    {
      id: "brief",
      kind: "brief" as const,
      text: "B".repeat(80),
      reference: "task:brief",
      priority: 100,
    },
    {
      id: "pack",
      kind: "context_pack" as const,
      text: "K".repeat(100),
      reference: "pack:pack",
      priority: 1000,
    },
  ];
  const options = {
    human: [{ type: "text" as const, text: "Build" }],
    fragments,
    estimate: estimator,
    hardCap: 190,
  };
  const first = enforceInjectionBudget(options);
  expect(first.shortened).toEqual(["pack"]);
  expect(first.injectedText).toContain("B".repeat(80));
  expect(enforceInjectionBudget(options)).toEqual(first);
  expect(fragments[1]?.text).toBe("K".repeat(100));
});
it("forces long peer bodies to references and requires a declared reminder policy", () => {
  expect(
    enforceInjectionBudget({
      estimate: estimator,
      human: [{ type: "text", text: "Go" }],
      fragments: [{ id: "peer", kind: "peer", text: "x".repeat(2001), reference: "message:peer" }],
    }).shortened,
  ).toEqual(["peer"]);
  const reminder = {
    id: "reminder",
    kind: "reminder" as const,
    text: "Remember",
    reference: "policy:reminder",
  };
  expect(() =>
    enforceInjectionBudget({
      estimate: estimator,
      human: [{ type: "text", text: "Go" }],
      fragments: [reminder],
    }),
  ).toThrow("undeclared_reminder");
});
it("refuses impossible fixed or reference budgets without dropping or mutating human input", () => {
  const human = [{ type: "text" as const, text: "Keep this" }];
  expect(() =>
    enforceInjectionBudget({
      estimate: estimator,
      human,
      fragments: [],
      fixedInjectedTokens: 11,
      hardCap: 10,
    }),
  ).toThrow("injection_fixed_budget_exceeded");
  expect(() =>
    enforceInjectionBudget({
      estimate: estimator,
      human,
      fragments: [
        { id: "peer", kind: "peer", text: "x".repeat(5000), reference: "required-reference" },
      ],
      hardCap: 10,
    }),
  ).toThrow("injection_budget_exceeded");
  expect(human).toEqual([{ type: "text", text: "Keep this" }]);
});
it("uses the configured first turn cap, measures wrapper text, and validates estimates", () => {
  const first = enforceInjectionBudget({
    estimate: estimator,
    human: [{ type: "text", text: "Go" }],
    fragments: [],
    firstTurn: true,
    fixedInjectedTokens: 2000,
  });
  expect(first.estimatedTokens).toBe(2000);
  expect(first.aboveAverage).toBe(true);
  expect(() =>
    enforceInjectionBudget({
      estimate: estimator,
      human: [{ type: "text", text: "Go" }],
      fragments: [],
      fixedInjectedTokens: 2000,
    }),
  ).toThrow("injection_fixed_budget_exceeded");
  expect(() =>
    enforceInjectionBudget({
      human: [{ type: "text", text: "Go" }],
      fragments: [],
      estimate: () => NaN,
    }),
  ).toThrow("invalid_token_estimate");
});
it("keeps context packs within their separate cap even when the first turn has more room", () => {
  const plan = enforceInjectionBudget({
    human: [{ type: "text", text: "Build" }],
    estimate: estimator,
    firstTurn: true,
    fragments: [
      { id: "one", kind: "context_pack", text: "A".repeat(800), reference: "pack:one" },
      {
        id: "two",
        kind: "context_pack",
        text: "B".repeat(800),
        reference: "pack:two",
        priority: 100,
      },
    ],
  });
  expect(plan.shortened).toEqual(["one"]);
  expect(plan.injectedText).toContain("B".repeat(800));
});
