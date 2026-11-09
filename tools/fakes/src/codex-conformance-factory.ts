import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { CodexAdapter, type CodexHost } from "@zoltbot/adapters-codex";
import type { AgentSession, OpenOptions } from "@zoltbot/adapters-sdk";
import type { ConformanceFactory } from "@zoltbot/adapters-sdk/conformance";
import { Logger, Redactor, Supervisor } from "@zoltbot/daemon";
import type { AgentDefinition, AgentEvent } from "@zoltbot/protocol";
import { hostMcpFixture } from "./host-mcp-fixture.js";
import { readyTransport } from "./ready-transport.js";

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
  testedVersions: "test-1",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
export const codexFactory: ConformanceFactory = async (scenario) => {
  mkdirSync(".cache/test-results/codex-conformance", { recursive: true });
  const cwd = mkdtempSync(path.resolve(`.cache/test-results/codex-conformance/${scenario}-`));
  const mcp = await hostMcpFixture();
  const token = mcp.token;
  const frameFile = path.join(cwd, "frames.jsonl");
  const host: CodexHost = {
    async schema() {
      return JSON.parse(
        readFileSync("fixtures/codex/0.164.0/protocol-experimental.schema.json", "utf8"),
      );
    },
    async probe() {
      return { installed: true, broken: false, login: "unknown" };
    },
    async connect(def, opts) {
      const supervisor = new Supervisor(
        {
          command: def.launch.command,
          args: def.launch.args,
          cwd: opts.cwd,
          env: { HOME: cwd, TMPDIR: cwd, TSX_DISABLE_CACHE: "1", CODEX_TEST_SCENARIO: scenario },
          frameFile,
          frameLimitBytes: 16384,
          killGraceMs: 25,
          backoffMs: 500,
        },
        new Logger(path.join(cwd, "adapter.log"), new Redactor([token, "seeded-secret", cwd])),
      );
      return readyTransport(supervisor);
    },
  };
  const adapter = new CodexAdapter(host, 1500);
  const options: OpenOptions = {
    mode: "new",
    cwd,
    identity: { agentId: "test-profile", threadId: "test-thread" },
    permissionProfile: "workspace_write",
    hostMcp: { url: mcp.url, token },
  };
  const session = await adapter.open(definition, options).catch(async (error) => {
    await mcp.close();
    throw error;
  });
  const sessions: AgentSession[] = [session];
  const trace: AgentEvent[] = [];
  const readers: Promise<void>[] = [];
  const consume = (s: AgentSession) =>
    readers.push(
      (async () => {
        for await (const event of s.events()) trace.push(event);
      })(),
    );
  consume(session);
  return {
    cwd,
    session,
    trace,
    async reopen(nativeId) {
      const resumed = await adapter.open(definition, { ...options, mode: "resume", nativeId });
      sessions.push(resumed);
      consume(resumed);
      return resumed;
    },
    async frameLog() {
      try {
        return readFileSync(frameFile, "utf8");
      } catch {
        return "";
      }
    },
    async childEnvironment() {
      return JSON.parse(readFileSync(path.join(cwd, "environment-keys.json"), "utf8"));
    },
    async dispose() {
      for (const s of sessions) await s.close();
      await Promise.all(readers);
      await mcp.close();
      if (scenario === "host_tools") mcp.assertCalled();
    },
  };
};
