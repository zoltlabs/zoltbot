import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AgentDefinition, experimentalProviderNotice } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { DetectionService } from "./service.js";

const builtin: AgentDefinition = {
  id: "sample",
  displayName: "Sample",
  adapter: "acp",
  binaryNames: ["sample"],
  versionCommand: ["--version"],
  launch: { command: "sample", args: ["acp"], env: {} },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
it("reports broken installs and version changes without retaining private CLI output", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/detect-service-"));
  try {
    writeFileSync(path.join(root, "sample"), "fixture");
    let version = "1.0.0";
    const service = new DetectionService({
      dataDir: root,
      home: root,
      builtins: [builtin],
      paths: [root],
      knownPaths: [],
      runner: async () => ({ code: 0, stdout: `sample ${version}`, stderr: "private detail" }),
    });
    expect((await service.scan())[0]?.install.selected?.version).toBe("1.0.0");
    version = "1.1.0";
    await service.scan();
    const report = await service.report();
    expect(JSON.stringify(report)).toContain("version_changed");
    expect(JSON.stringify(report)).not.toContain("private detail");
    rmSync(path.join(root, "sample"));
    expect((await service.scan())[0]?.install.selected).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("requires explicit confirmation before invoking a visible fix host", async () => {
  const service = new DetectionService({
    dataDir: ".cache/tests",
    home: ".cache/tests",
    builtins: [builtin],
    paths: [],
    knownPaths: [],
    fixes: {
      run: async () => {
        throw new Error("must not run");
      },
    },
  });
  await expect(service.fix("sample", "login", false)).rejects.toThrow("fix_confirmation_required");
  await expect(service.fix("sample", "invented", true)).rejects.toThrow("unknown_fix");
});

it("scans acknowledged Antigravity through ordinary provider discovery", async () => {
  const service = new DetectionService({
    dataDir: ".cache/tests",
    home: ".cache/tests",
    builtins: [{ ...builtin, id: "antigravity", flavor: "antigravity", experimental: true }],
    preference: () => ({ enabled: true, noticeVersion: experimentalProviderNotice.id }),
    paths: [],
    knownPaths: [],
    runner: async () => {
      throw new Error("must not launch");
    },
  });
  expect(await service.scan()).toEqual([
    {
      definitionId: "antigravity",
      displayName: "Sample",
      install: { candidates: [] },
    },
  ]);
});
it("updates a colon named builtin override in its existing user file and reports the override", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/definition-save-"));
  try {
    mkdirSync(path.join(root, "definitions"));
    const definition = { ...builtin, id: "pi:openrouter", adapter: "pi" };
    const file = path.join(root, "definitions/custom-profile.json");
    writeFileSync(file, JSON.stringify({ ...definition, displayName: "Custom" }));
    const service = new DetectionService({
      dataDir: root,
      home: root,
      builtins: [definition],
      paths: [],
      knownPaths: [],
    });
    await service.upsert({ ...definition, displayName: "Updated" });
    const loaded = await service.definitions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.definitions[0]?.displayName).toBe("Updated");
    expect(loaded.overridden).toEqual(["pi:openrouter"]);
    await service.scan();
    expect((await service.report()).checks).toContainEqual(
      expect.objectContaining({ kind: "agent", definitionId: "pi:openrouter", overridden: true }),
    );
    const { readFileSync, readdirSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(file, "utf8")).displayName).toBe("Updated");
    expect(readdirSync(path.join(root, "definitions"))).toEqual(["custom-profile.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("rejects ambiguous duplicate user definitions rather than adding a third copy", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/definition-duplicate-"));
  try {
    mkdirSync(path.join(root, "definitions"));
    writeFileSync(path.join(root, "definitions/one.json"), JSON.stringify(builtin));
    writeFileSync(path.join(root, "definitions/two.json"), JSON.stringify(builtin));
    const service = new DetectionService({
      dataDir: root,
      home: root,
      builtins: [builtin],
      paths: [],
      knownPaths: [],
    });
    await expect(service.upsert(builtin)).rejects.toThrow("duplicate_definition");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("stores object property names as ordinary definition IDs", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/definition-id-"));
  try {
    const service = new DetectionService({
      dataDir: root,
      home: root,
      builtins: [],
      paths: [],
      knownPaths: [],
    });
    await service.upsert({ ...builtin, id: "constructor" });
    expect((await service.definitions()).definitions.map((item) => item.id)).toEqual([
      "constructor",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("requires credential references when saving a definition", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/definition-credential-"));
  try {
    const service = new DetectionService({
      dataDir: root,
      home: root,
      builtins: [],
      paths: [],
      knownPaths: [],
    });
    await expect(
      service.upsert({
        ...builtin,
        launch: { ...builtin.launch, env: { EXAMPLE_API_KEY: "private-synthetic-key" } },
      }),
    ).rejects.toThrow("credential_reference_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("queries package managers only after direct discovery fails and only once per scan", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/package-fallback-"));
  const bin = path.join(root, "hidden/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "first-cli"), "fixture");
  writeFileSync(path.join(bin, "second-cli"), "fixture");
  try {
    let queries = 0;
    const runner: import("./process.js").CommandRunner = async (command) => {
      if (command === "npm") {
        queries++;
        return { code: 0, stdout: path.join(root, "hidden/lib/node_modules"), stderr: "" };
      }
      if (command === "brew") {
        queries++;
        return { code: 1, stdout: "", stderr: "private-error" };
      }
      return { code: 0, stdout: "tool 1.0.0", stderr: "" };
    };
    const definitions = [
      { ...builtin, id: "first", binaryNames: ["first-cli"] },
      { ...builtin, id: "second", binaryNames: ["second-cli"] },
    ];
    const service = new DetectionService({
      dataDir: root,
      home: root,
      builtins: definitions,
      paths: [],
      knownPaths: [],
      runner,
    });
    expect((await service.scan()).map((item) => item.install.selected?.source)).toEqual([
      "package_manager",
      "package_manager",
    ]);
    expect(queries).toBe(2);
    await service.scan();
    expect(queries).toBe(4);
    const direct = new DetectionService({
      dataDir: root,
      home: root,
      builtins: definitions,
      paths: [bin],
      knownPaths: [],
      runner,
    });
    expect((await direct.scan()).every((item) => item.install.selected?.source === "path")).toBe(
      true,
    );
    expect(queries).toBe(4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reports negotiated runtime capabilities and host transport without claiming unknown login", async () => {
  const service = new DetectionService({
    dataDir: ".cache/tests",
    home: ".cache/tests",
    builtins: [builtin],
    paths: [],
    knownPaths: [],
    runtime: () => ({ state: "ready", capabilities: { resume: true, hostTools: "mcp_http" } }),
  });
  await service.scan();
  const report = await service.report();
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      kind: "agent",
      runtime: expect.objectContaining({ state: "ready" }),
      capabilities: { resume: true, hostTools: "mcp_http" },
      hostTools: "mcp_http",
      login: { state: "unknown" },
    }),
  );
});
