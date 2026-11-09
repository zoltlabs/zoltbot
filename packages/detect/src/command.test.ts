import { expect, it } from "vitest";
import { parseCommand } from "./command.js";

it("parses argv including quoted executable paths without invoking a shell", () => {
  expect(parseCommand('"/Applications/My Agent/bin/agent" acp --name "My agent"')).toEqual([
    "/Applications/My Agent/bin/agent",
    "acp",
    "--name",
    "My agent",
  ]);
  expect(parseCommand("opencode acp")).toEqual(["opencode", "acp"]);
  expect(parseCommand("agent --label 'two words' --empty ''")).toEqual([
    "agent",
    "--label",
    "two words",
    "--empty",
    "",
  ]);
});
it("rejects shell syntax, credentials, malformed quoting, and oversized commands", () => {
  for (const text of [
    "agent; touch marker",
    "agent | other",
    "agent && other",
    "agent > file",
    "KEY=value agent",
    "agent $(whoami)",
    "agent `whoami`",
    "agent --api-key private",
    "agent --token=private",
    "agent 'unterminated",
    "agent\nother",
    `agent ${"x".repeat(8192)}`,
    "",
  ]) {
    expect(() => parseCommand(text)).toThrow();
  }
});
