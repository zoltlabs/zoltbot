import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

function check(source: string, file = "input.ts") {
  const root = mkdtempSync(path.join(tmpdir(), "public-boundary-"));
  try {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
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

it("refuses Node-only dependencies and full snapshots inside the cell", () => {
  for (const specifier of [
    "node:fs",
    "fs",
    "@zoltbot/daemon",
    "better-sqlite3",
    "../../daemon/src/api.js",
  ])
    expect(() =>
      check(`import value from ${JSON.stringify(specifier)};`, "packages/cell/src/handler.ts"),
    ).toThrow();
  expect(() => check("store.snapshot()", "packages/cell/src/handler.ts")).toThrow();
  expect(check('import value from "node:fs";', "packages/cell/src/handler.test.ts")).toContain(
    "passed",
  );
});
