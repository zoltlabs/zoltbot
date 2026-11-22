import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { ClaudeHost, ClaudeLaunch } from "./host.js";
import { ClaudeAdapter } from "./index.js";

const definition: AgentDefinition = {
  id: "claude-test",
  displayName: "Claude test",
  adapter: "claude",
  binaryNames: [],
  versionCommand: [],
  launch: {
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("tools/fakes/src/claude-conformance-provider.ts")],
    env: {},
  },
  testedVersions: "2.1.299",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};

function host(cwd: string, login: "signed_in" | "signed_out" = "signed_in") {
  const launches: ClaudeLaunch[] = [];
  let configs = 0;
  const value: ClaudeHost = {
    async probe() {
      return { installed: true, broken: false, version: "2.1.299", login };
    },
    async config() {
      configs++;
      throw new Error("unexpected_config");
    },
    async connect(_definition, _options, launch) {
      launches.push(launch);
      const child = spawn(launch.command, launch.args, {
        cwd,
        env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", HOME: cwd, TMPDIR: cwd },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
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
  return { value, launches, configs: () => configs };
}

function directory() {
  mkdirSync(".cache/tests", { recursive: true });
  return mkdtempSync(path.resolve(".cache/tests/claude-models-"));
}

it("lists models from initialize without a prompt, session id or transcript", async () => {
  const cwd = directory();
  const test = host(cwd);
  try {
    const models = await new ClaudeAdapter(test.value).listModels(definition);
    expect(models).toEqual({ list: [{ id: "model", name: "Model" }], effort: [] });
    expect(test.launches).toHaveLength(1);
    const args = test.launches[0]?.args ?? [];
    expect(args).toContain("--no-session-persistence");
    for (const flag of ["--session-id", "--resume", "--mcp-config", "--fork-session"])
      expect(args).not.toContain(flag);
    expect(test.configs()).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("does not start Claude when it is signed out", async () => {
  const cwd = directory();
  const test = host(cwd, "signed_out");
  try {
    await expect(new ClaudeAdapter(test.value).listModels(definition)).rejects.toThrow(
      "auth_required",
    );
    expect(test.launches).toHaveLength(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
