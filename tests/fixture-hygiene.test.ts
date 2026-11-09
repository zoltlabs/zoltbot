import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("rejects personal paths and credential fields before fixture commits", () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/hygiene-"));
  try {
    writeFileSync(
      path.join(root, "leak.json"),
      JSON.stringify({ cwd: "/Users/example-person/private", password: "private-value" }),
    );
    expect(() =>
      execFileSync(process.execPath, ["scripts/fixture-hygiene.mjs", root], { stdio: "pipe" }),
    ).toThrow(/personal home path/);
    writeFileSync(
      path.join(root, "leak.json"),
      JSON.stringify({ cwd: "/work/repo", password: "[redacted]" }),
    );
    expect(
      execFileSync(process.execPath, ["scripts/fixture-hygiene.mjs", root], { encoding: "utf8" }),
    ).toContain("passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
