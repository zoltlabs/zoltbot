import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { enforceInjectionBudget } from "@zoltbot/core";
import { expect, it } from "vitest";

it("enforces the reference tokenizer budget while preserving a long human message", () => {
  const human = [
    { type: "text" as const, text: "Preserve this complete human message. ".repeat(1000) },
  ];
  const result = enforceInjectionBudget({
    human,
    estimate: referenceTokenEstimate,
    hardCap: 200,
    fragments: [
      {
        id: "pack",
        kind: "context_pack",
        text: "Evidence and project context. ".repeat(400),
        reference: "pack:current",
      },
      {
        id: "brief",
        kind: "brief",
        text: "Review the implementation. Preserve keyboard behavior and report validation results.",
        reference: "task:brief",
        priority: 100,
      },
    ],
  });
  expect(result.estimatedTokens).toBeLessThanOrEqual(200);
  expect(result.shortened).toContain("pack");
  expect(result.input[0]).toEqual(human[0]);
  expect(result.input.at(-1)).toEqual({ type: "text", text: result.injectedText });
});
