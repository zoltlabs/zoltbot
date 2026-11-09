import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { approvalPaths } from "./approval-paths.js";

it("resolves existing targets and new descendants against the canonical workspace", () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/approval-paths-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, "src", "existing.ts"), "synthetic");
    symlinkSync(workspace, path.join(root, "alias"));
    expect(approvalPaths(path.join(root, "alias"), ["src/existing.ts", "src/new/deep.ts"])).toEqual(
      ["src/existing.ts", "src/new/deep.ts"],
    );
    expect(approvalPaths(workspace, [path.join(workspace, "src/existing.ts")])).toEqual([
      "src/existing.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses escaped paths, ambiguous traversal, missing workspaces, and symlink escapes", () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/approval-escape-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "target"), "synthetic");
    symlinkSync(outside, path.join(workspace, "escape"));
    symlinkSync(path.join(outside, "missing"), path.join(workspace, "dangling"));
    for (const target of [
      path.join(outside, "target"),
      "../outside/target",
      "escape/target",
      "escape/new/target",
      "dangling/new",
      "escape/../target",
      "a\u0000b",
      "a\\b",
      "",
    ])
      expect(approvalPaths(workspace, [target])).toBeUndefined();
    expect(approvalPaths(path.join(root, "missing"), ["target"])).toBeUndefined();
    expect(approvalPaths(workspace, [])).toBeUndefined();
    expect(approvalPaths(workspace, Array(101).fill("target"))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("checks every target and re-resolves paths when a parent changes", () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/approval-change-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    mkdirSync(outside);
    expect(approvalPaths(workspace, ["src/new.ts"])).toEqual(["src/new.ts"]);
    rmSync(path.join(workspace, "src"), { recursive: true });
    symlinkSync(outside, path.join(workspace, "src"));
    expect(approvalPaths(workspace, ["safe.ts", "src/new.ts"])).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
