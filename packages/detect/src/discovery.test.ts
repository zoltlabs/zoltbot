import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverBinaries, LoginPath } from "./discovery.js";
import type { CommandRunner } from "./process.js";

const roots: string[] = [];
function fixture() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/discovery-"));
  roots.push(root);
  for (const dir of ["first", "second", "known"]) {
    mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, dir, "agent"), "fixture");
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("ignores broken PATH entries, ranks tested versions, and notices removal on rescan", async () => {
  const root = fixture();
  const runner: CommandRunner = async (command) =>
    command.includes("first")
      ? { code: 1, stdout: "", stderr: "private account detail" }
      : { code: 0, stdout: command.includes("known") ? "agent 1.3.0" : "agent 1.2.0", stderr: "" };
  const options = {
    binaryNames: ["agent"],
    versionCommand: ["--version"],
    testedVersions: "^1.0.0",
    path: [path.join(root, "first"), path.join(root, "second")],
    knownDirectories: [path.join(root, "known")],
    cwd: root,
    runner,
  };
  const scan = await discoverBinaries(options);
  expect(scan.selected?.version).toBe("1.3.0");
  expect(scan.candidates[0]).toMatchObject({ state: "broken", error: "version_failed" });
  expect(JSON.stringify(scan)).not.toContain("private account");
  rmSync(path.join(root, "known", "agent"));
  expect((await discoverBinaries(options)).selected?.version).toBe("1.2.0");
  const override = await discoverBinaries({
    ...options,
    override: path.join(root, "second", "agent"),
  });
  expect(override.selected?.source).toBe("override");
});
it("caches only login PATH and uses a static shell command", async () => {
  let calls = 0;
  const runner: CommandRunner = async (_command, args) => {
    calls++;
    expect(args[0]).toBe("-lc");
    expect(args[1]).toContain("ZOLTBOT_PATH=");
    return { code: 0, stdout: "shell greeting\nZOLTBOT_PATH=/one:/two\n", stderr: "" };
  };
  const resolver = new LoginPath(runner);
  expect(await resolver.resolve("/bin/zsh", { cwd: fixture(), inherited: {} })).toEqual([
    "/one",
    "/two",
  ]);
  expect(await resolver.resolve("/bin/zsh", { cwd: ".", inherited: {} })).toEqual(["/one", "/two"]);
  expect(calls).toBe(1);
});
