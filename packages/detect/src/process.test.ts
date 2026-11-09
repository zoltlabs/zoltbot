import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { processEnvironment, runCommand } from "./process.js";

const roots: string[] = [];
function cwd() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/detect-process-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("uses argv without a shell and filters inherited credentials", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({arg:process.argv[1],secret:process.env.ZOLTBOT_UNLISTED_SECRET,explicit:process.env.EXPLICIT_FLAG}))",
      "literal;not-a-command",
    ],
    {
      cwd: cwd(),
      env: { EXPLICIT_FLAG: "present" },
      inherited: { PATH: process.env.PATH, ZOLTBOT_UNLISTED_SECRET: "private" },
    },
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ arg: "literal;not-a-command", explicit: "present" });
});
it("bounds a hung or excessively chatty process and reports generic failures", async () => {
  const root = cwd();
  const hung = await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: root,
    timeoutMs: 30,
    killGraceMs: 10,
  });
  expect(hung.failure).toBe("timeout");
  const noisy = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(50000));setInterval(()=>{},1000)"],
    { cwd: root, maxOutputBytes: 1024, killGraceMs: 10 },
  );
  expect(noisy.failure).toBe("output_limit");
  expect(Buffer.byteLength(noisy.stdout)).toBeLessThanOrEqual(1024);
  const missing = await runCommand(path.join(root, "missing"), [], { cwd: root });
  expect(missing.failure).toBe("not_found");
});

it("keeps the account name macOS CLIs need for their Keychain login and drops secrets", () => {
  expect(
    processEnvironment(
      {
        HOME: "/Users/someone",
        USER: "someone",
        LOGNAME: "someone",
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "secret",
        GITHUB_TOKEN: "secret",
      },
      { CLAUDE_CONFIG_DIR: "/config" },
    ),
  ).toEqual({
    HOME: "/Users/someone",
    USER: "someone",
    LOGNAME: "someone",
    PATH: "/usr/bin",
    CLAUDE_CONFIG_DIR: "/config",
  });
});
