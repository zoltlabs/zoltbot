import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition } from "@zoltbot/protocol";
import { afterEach, expect, it } from "vitest";
import { loadDefinitions } from "./definitions.js";

const roots: string[] = [];
const builtin: AgentDefinition = {
  id: "sample",
  displayName: "Sample",
  adapter: "acp",
  binaryNames: ["sample"],
  versionCommand: ["--version"],
  launch: { command: "{binary}", args: ["acp"], env: {} },
  testedVersions: "^1.0.0",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
function root() {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/definitions-"));
  roots.push(dir);
  mkdirSync(path.join(dir, "definitions"));
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("applies validated overrides while retaining builtins for invalid documents", async () => {
  const dir = root();
  const file = path.join(dir, "definitions/sample.json");
  writeFileSync(file, JSON.stringify({ ...builtin, displayName: "Custom" }));
  expect((await loadDefinitions([builtin], dir)).definitions[0]?.displayName).toBe("Custom");
  writeFileSync(file, JSON.stringify({ ...builtin, launch: { command: "bad" } }));
  const result = await loadDefinitions([builtin], dir);
  expect(result.definitions).toEqual([builtin]);
  expect(result.errors).toEqual([{ file: "sample.json", code: "invalid_definition" }]);
});
it("does not follow definition symlinks or enable experimental providers without the current notice", async () => {
  const dir = root();
  const { symlinkSync } = await import("node:fs");
  writeFileSync(path.join(dir, "outside.json"), JSON.stringify({ ...builtin, id: "outside" }));
  symlinkSync(path.join(dir, "outside.json"), path.join(dir, "definitions/link.json"));
  const result = await loadDefinitions(
    [builtin, { ...builtin, id: "experiment", experimental: true }],
    dir,
  );
  expect(result.definitions.map((item) => item.id)).toEqual(["sample"]);
  expect(result.errors).toEqual([{ file: "link.json", code: "unsafe_definition_file" }]);
});
it("rejects embedded credential values instead of returning them through definition metadata", async () => {
  const dir = root();
  writeFileSync(
    path.join(dir, "definitions/private.json"),
    JSON.stringify({
      ...builtin,
      launch: { ...builtin.launch, env: { EXAMPLE_API_KEY: "private-synthetic-key" } },
    }),
  );
  const result = await loadDefinitions([builtin], dir);
  expect(result.definitions).toEqual([builtin]);
  expect(result.errors).toEqual([{ file: "private.json", code: "credential_reference_required" }]);
  expect(JSON.stringify(result)).not.toContain("private-synthetic-key");
});
