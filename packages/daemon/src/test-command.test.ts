import { expect, it } from "vitest";
import { isTestCommand } from "./test-command.js";

it("recognizes test runner invocations instead of mentions of tests", () => {
  for (const command of [
    "node --test",
    "cd /workspace && node --test",
    "pnpm test",
    "npm run test:unit",
    "python -m pytest",
    "cargo test",
  ])
    expect(isTestCommand({ command })).toBe(true);
  for (const command of [
    "echo tests passed",
    "cat test/example.js",
    "git diff test/example.js",
    "node app.js",
  ])
    expect(isTestCommand({ command })).toBe(false);
});

it("does not count commands that can mask or bypass the test runner's exit status", () => {
  for (const command of [
    "node --test || true",
    "true || node --test",
    "node --test; echo done",
    "node --test && echo done",
    "node --test | cat",
  ])
    expect(isTestCommand({ command })).toBe(false);
});

it("recognizes native shell wrappers and executable paths", () => {
  for (const command of [
    ["/bin/zsh", "-lc", "node --test"],
    "/bin/zsh -lc 'node --test'",
    "/usr/local/bin/node --test",
  ])
    expect(isTestCommand({ command })).toBe(true);
  expect(isTestCommand({ command: ["/bin/zsh", "-lc", "echo tests passed"] })).toBe(false);
});
