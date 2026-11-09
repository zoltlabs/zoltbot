import { expect, it } from "vitest";
import { claudeModelOptions } from "./session-capabilities.js";

it("lists Claude's models and every effort level some model accepts", () => {
  expect(
    claudeModelOptions([
      { value: "opus", displayName: "Opus", supportedEffortLevels: ["low", "high", "max"] },
      { value: "haiku", displayName: "Haiku" },
      { value: "sonnet", supportedEffortLevels: ["low", "medium", "high"] },
      { displayName: "No id" },
      null,
    ]),
  ).toEqual({
    list: [
      { id: "opus", name: "Opus" },
      { id: "haiku", name: "Haiku" },
      { id: "sonnet", name: "sonnet" },
    ],
    effort: ["low", "high", "max", "medium"],
  });
});
