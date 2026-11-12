import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { ClaudeAdapter, type ClaudeHost } from "@zoltbot/adapters-claude";
import type { AgentSession, OpenOptions } from "@zoltbot/adapters-sdk";
import type { ConformanceFactory } from "@zoltbot/adapters-sdk/conformance";
import { Logger, Redactor, RuntimeFiles, Supervisor } from "@zoltbot/daemon";
import type { AgentDefinition, AgentEvent } from "@zoltbot/protocol";
import { hostMcpFixture } from "./host-mcp-fixture.js";
import { readyTransport } from "./ready-transport.js";

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
  testedVersions: "test-1",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
export const claudeFactory: ConformanceFactory = async (scenario) => {
  mkdirSync(".cache/test-results/claude-conformance", { recursive: true });
  const cwd = mkdtempSync(path.resolve(`.cache/test-results/claude-conformance/${scenario}-`));
  const mcp = await hostMcpFixture();
  const token = mcp.token;
  const frameFile = path.join(cwd, "frames.jsonl");
  const files = new RuntimeFiles(path.join(cwd, "private-runtime"));
  const host: ClaudeHost = {
    config: (content) => files.config(content),
    async probe() {
      return { installed: true, broken: false, login: "unknown" };
    },
    async connect(_def, opts, launch) {
      const supervisor = new Supervisor(
        {
          command: launch.command,
          args: launch.args,
          cwd: opts.cwd,
          env: { HOME: cwd, TMPDIR: cwd, TSX_DISABLE_CACHE: "1" },
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
  // Keep fixture RPCs bounded without racing SDK initialization on a busy host.
  const adapter = new ClaudeAdapter(host, 5000);
  const options: OpenOptions = {
    mode: "new",
    cwd,
    identity: { agentId: "test-profile", threadId: "test-thread" },
    permissionProfile: "workspace_write",
    hostMcp: { url: mcp.url, token },
  };
  const session = await adapter.open(definition, options).catch(async (error) => {
    await files.close();
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
      if (scenario === "host_tools") mcp.assertCalled();
      await files.close();
      await mcp.close();
    },
  };
};
