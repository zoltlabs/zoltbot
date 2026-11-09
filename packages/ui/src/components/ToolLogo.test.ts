import { expect, it } from "vitest";
import { toolLogo } from "./ToolLogo.js";

it("finds the logo for a definition id, including tools reached through Pi", () => {
  expect(toolLogo("claude")).toBeDefined();
  expect(toolLogo("codex")?.mono).toBe(true);
  expect(toolLogo("pi:deepseek")).toBe(toolLogo("deepseek"));
  expect(toolLogo("goose")).toBeUndefined();
  expect(toolLogo(undefined)).toBeUndefined();
});
