import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
function fixture(file: string, text: string) {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/quality-"));
  roots.push(root);
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
  return root;
}
function check(root: string) {
  return execFileSync(process.execPath, ["scripts/quality.mjs", root], {
    encoding: "utf8",
    stdio: "pipe",
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("repository quality gates", () => {
  it("accepts permitted imports", () => {
    expect(
      check(fixture("packages/core/src/a.ts", 'import type { Task } from "@zoltbot/protocol";')),
    ).toContain("passed");
  });
  it.each([
    'import { Store } from "@zoltbot/store";',
    'export { Store } from "../../store/src/index.js";',
    'const store = await import("@zoltbot/store");',
    'const store = require("@zoltbot/store");',
  ])("rejects UI access to store: %s", (text) => {
    expect(() => check(fixture("packages/ui/src/a.ts", text))).toThrow(/forbidden import/);
  });
  it("rejects IO in core", () => {
    expect(() => check(fixture("packages/core/src/a.ts", 'import fs from "node:fs";'))).toThrow(
      /forbidden import/,
    );
  });
  it("rejects synthetic 900 line files", () => {
    expect(() => check(fixture("packages/ui/src/large.ts", "\n".repeat(900)))).toThrow(
      /900 lines exceeds 800/,
    );
  });
  it("rejects untracked TODOs", () => {
    expect(() => check(fixture("packages/core/src/a.ts", "// TODO fix this\n"))).toThrow(
      /BL reference/,
    );
  });
  it("accepts TODOs only with an existing backlog reference", () => {
    const root = fixture("packages/core/src/a.ts", "// TODO BL-001 fix this\n");
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs/backlog.md"), "BL-001: tracked work\n");
    expect(check(root)).toContain("passed");
  });
  it("fails on untokenized stylesheet values unless a line allows them", () => {
    const root = fixture(
      "packages/ui/src/a.css",
      ".a {\n  color: #fff;\n  font-size: 13px;\n  background: linear-gradient(red, blue);\n  border-radius: var(--zb-radius-sm);\n  color: #000; /* tokens: allow */\n}\n",
    );
    const run = () => check(root);
    expect(run).toThrow(/a\.css:2: literal color/);
    expect(run).toThrow(/a\.css:3: font-size is not a token/);
    expect(run).toThrow(/a\.css:4: gradient or backdrop filter/);
    expect(run).not.toThrow(/a\.css:[56]/);
  });
});
