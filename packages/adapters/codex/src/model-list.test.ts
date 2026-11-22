import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { CodexHost } from "./host.js";
import { CodexAdapter } from "./index.js";

const definition: AgentDefinition = {
  id: "codex-test",
  displayName: "Codex test",
  adapter: "codex",
  binaryNames: [],
  versionCommand: [],
  launch: {
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("tools/fakes/src/codex-conformance-provider.ts")],
    env: {},
  },
  testedVersions: "0.164.0",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};

it("lists models through model/list without starting a thread", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const cwd = mkdtempSync(path.resolve(".cache/tests/codex-models-"));
  let exited: Promise<void> | undefined;
  const host: CodexHost = {
    privateRead() {},
    async probe() {
      return { installed: true, broken: false, version: "0.164.0", login: "signed_in" };
    },
    async schema() {
      return JSON.parse(
        readFileSync("fixtures/codex/0.164.0/protocol-experimental.schema.json", "utf8"),
      );
    },
    async connect(def) {
      const child = spawn(def.launch.command, def.launch.args, {
        cwd,
        env: {
          PATH: process.env.PATH,
          TSX_DISABLE_CACHE: "1",
          HOME: cwd,
          TMPDIR: cwd,
          CODEX_TEST_SCENARIO: "service_tier",
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      exited = closed;
      return {
        input: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        output: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        closed,
        async close() {
          child.kill("SIGTERM");
          await closed;
        },
      };
    },
  };
  try {
    const models = await new CodexAdapter(host).listModels(definition);
    expect(models).toEqual({ list: [{ id: "fake-model", name: "Fake model" }], effort: [] });
    // The app-server stops once nothing uses it, and it never wrote a thread.
    await exited;
    expect(existsSync(path.join(cwd, "codex-native.json"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
