import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { executionFingerprint, rejectActiveHook } from "./hooks.js";

it.skipIf(process.platform === "win32")(
  "treats core.hooksPath=/dev/null as disabled hooks",
  async () => {
    mkdirSync(".cache/tests", { recursive: true });
    const root = mkdtempSync(path.resolve(".cache/tests/disabled-hooks-"));
    try {
      execFileSync("git", ["init", root], { stdio: "ignore" });
      execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: root });
      await expect(rejectActiveHook(root, "post-checkout")).resolves.toBeUndefined();
      const first = await executionFingerprint(root);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(await executionFingerprint(root)).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
