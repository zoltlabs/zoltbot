import { expect, it } from "vitest";
import { claudeModelOptions, claudeServiceTiers } from "./session-capabilities.js";

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

it("offers fast mode only when Claude reports it and nothing rules it out", () => {
  expect(claudeServiceTiers({})).toEqual([]);
  expect(claudeServiceTiers({ fast_mode_state: "off" })).toEqual(["fast"]);
  expect(
    claudeServiceTiers({ fast_mode_state: "off", fast_mode_disabled_reason: "model_not_allowed" }),
  ).toEqual(["fast"]);
  expect(
    claudeServiceTiers({ fast_mode_state: "off", fast_mode_disabled_reason: "not_first_party" }),
  ).toEqual([]);
  expect(claudeServiceTiers({ fast_mode_state: "off", fast_mode_disabled_reason: "free" })).toEqual(
    [],
  );
});
