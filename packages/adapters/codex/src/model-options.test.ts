import { expect, it } from "vitest";
import { codexModelOptions } from "./index.js";

it("lists visible Codex models and the reasoning efforts they accept", () => {
  expect(
    codexModelOptions([
      {
        id: "gpt-5",
        displayName: "GPT-5",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
      },
      { id: "mini", supportedReasoningEfforts: ["minimal", "low"] },
      { id: "secret", hidden: true, supportedReasoningEfforts: ["xhigh"] },
    ]),
  ).toEqual({
    list: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "mini", name: "mini" },
    ],
    effort: ["low", "high", "minimal"],
  });
});
