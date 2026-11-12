import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

function check(source: string) {
  const root = mkdtempSync(path.join(tmpdir(), "public-boundary-"));
  try {
    writeFileSync(path.join(root, "input.ts"), source);
    return execFileSync(process.execPath, ["scripts/public-boundary.mjs", root], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
it("allows cloud as public routing metadata", () => {
  expect(check('export const method = { where: "cloud" };')).toContain(
    "Public dependency boundary passed",
  );
});
it("still refuses imports from private source paths and a bare private module", () => {
  const privatePath = ["..", "cloud", "server.js"].join("/");
  for (const specifier of [privatePath, "cloud"])
    expect(() => check(`import value from ${JSON.stringify(specifier)};`)).toThrow();
  expect(() => check(`const module = import(${JSON.stringify("cloud")});`)).toThrow();
});
