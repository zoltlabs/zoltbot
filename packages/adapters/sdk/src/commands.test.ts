import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { nativeCommands } from "./commands.js";

it("uses the captured native initialize catalog and keeps its public command metadata", () => {
  const line = readFileSync("fixtures/claude/2.1.299/initialize-no-auth.jsonl", "utf8")
    .trim()
    .split("\n")[0];
  const response = JSON.parse(line ?? "{}").response.response;
  const commands = nativeCommands(response.commands);
  expect(commands).toHaveLength(48);
  expect(commands.find((command) => command.name === "design")?.argumentHint).toBe(
    "consent | revoke",
  );
});
it("bounds and deduplicates advertised commands without exposing the private ready handshake", () => {
  expect(
    nativeCommands([
      { name: "zoltbot_ready" },
      { name: "fixture", description: "Native fixture", argumentHint: "file" },
      { name: "fixture" },
      { name: "invalid command" },
      null,
    ]),
  ).toEqual([{ name: "fixture", description: "Native fixture", argumentHint: "file" }]);
  expect(
    nativeCommands(Array.from({ length: 150 }, (_, index) => ({ name: `c${index}` }))),
  ).toHaveLength(100);
});
