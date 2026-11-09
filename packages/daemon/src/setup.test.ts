import { AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { builtinDefinitions } from "./setup.js";

it("loads all verified definition data without launching a CLI or choosing a model", () => {
  expect(new Set(builtinDefinitions.map((item) => item.id)).size).toBe(builtinDefinitions.length);
  expect(builtinDefinitions.map((item) => item.id)).toEqual(
    expect.arrayContaining([
      "claude",
      "codex",
      "pi",
      "pi:deepseek",
      "pi:openrouter",
      "cursor",
      "opencode",
      "grok",
      "cline",
      "goose",
      "qwen",
      "kimi",
      "copilot",
    ]),
  );
  expect(builtinDefinitions.some((definition) => definition.id === "gemini")).toBe(false);
  for (const definition of builtinDefinitions)
    expect(parse(AgentDefinitionSchema, definition)).toEqual(definition);
});
