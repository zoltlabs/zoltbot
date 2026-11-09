import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { DetectionService } from "./service.js";
import { fetchLatest, releaseUrl } from "./updates.js";

const definition: AgentDefinition = {
  id: "sample",
  displayName: "Sample",
  adapter: "acp",
  binaryNames: ["sample"],
  versionCommand: ["--version"],
  launch: { command: "sample", args: ["acp"], env: {} },
  update: { args: ["update"], latest: { url: "https://example.test/latest", key: "version" } },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
const respond =
  (body: string, status = 200) =>
  async () =>
    new Response(body, { status });

it("reads published versions from JSON fields and text patterns", async () => {
  expect(
    await fetchLatest(
      { url: "https://example.test", key: "version" },
      respond('{"version":"1.5.2","url":"private"}'),
    ),
  ).toBe("1.5.2");
  expect(
    await fetchLatest(
      { url: "https://example.test", pattern: "lab/([0-9][0-9A-Za-z.-]+)/" },
      respond('DOWNLOAD_URL="https://downloads.example.test/lab/2026.11.05-86047df/darwin"'),
    ),
  ).toBe("2026.11.5-86047df");
  expect(await fetchLatest({ url: "https://example.test", key: "version" }, respond("{}"))).toBe(
    undefined,
  );
  expect(
    await fetchLatest({ url: "https://example.test", key: "version" }, respond("", 404)),
  ).toBeUndefined();
  expect(
    await fetchLatest({ url: "http://example.test", key: "version" }, async () => {
      throw new Error("must not fetch");
    }),
  ).toBeUndefined();
  expect(releaseUrl("https://example.test/{os}_{arch}.json", "darwin", "x64")).toBe(
    "https://example.test/darwin_amd64.json",
  );
});

it("offers newer releases once a day and runs only a confirmed update", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/detect-updates-"));
  try {
    writeFileSync(path.join(root, "sample"), "fixture");
    let installed = "1.5.1",
      latest = "1.5.2",
      fetches = 0,
      now = 0,
      enabled = true;
    const runs: string[][] = [];
    const service = new DetectionService({
      dataDir: root,
      home: root,
      builtins: [definition],
      paths: [root],
      knownPaths: [],
      now: () => now,
      updateChecks: () => enabled,
      fetch: async () => {
        fetches++;
        return new Response(JSON.stringify({ version: latest }));
      },
      runner: async (_command, args) => {
        if (args[0] === "update") {
          runs.push(args);
          installed = latest;
        }
        return { code: 0, stdout: `sample ${installed}`, stderr: "" };
      },
    });
    expect(await service.updates()).toEqual([
      {
        definitionId: "sample",
        displayName: "Sample",
        installed: "1.5.1",
        latest: "1.5.2",
        command: ["sample", "update"],
      },
    ]);
    latest = "1.5.3";
    await service.updates();
    expect(fetches).toBe(1);
    now = 24 * 60 * 60 * 1000;
    expect((await service.updates())[0]?.latest).toBe("1.5.3");
    expect(fetches).toBe(2);
    await expect(service.update("sample", false)).rejects.toThrow("update_confirmation_required");
    expect(runs).toEqual([]);
    expect(await service.update("sample", true)).toEqual({ version: "1.5.3" });
    expect(runs).toEqual([["update"]]);
    expect(await service.updates()).toEqual([]);
    enabled = false;
    latest = "9.0.0";
    now *= 3;
    expect(await service.updates()).toEqual([]);
    expect(fetches).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
