import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { ClaudeHost } from "./host.js";
import { ClaudeAdapter } from "./index.js";
import { claudeModes, claudeOptions, claudeSafeModes } from "./launch.js";

const definition: AgentDefinition = {
  id: "claude",
  displayName: "Claude",
  adapter: "claude",
  binaryNames: ["claude"],
  versionCommand: ["--version"],
  launch: { command: "claude", args: [], env: {} },
  testedVersions: "2.1.299",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
const options: OpenOptions = {
  mode: "new",
  cwd: "/work/repo",
  identity: { agentId: "profile", threadId: "thread" },
  permissionProfile: "read_only",
  appendInstructions: "Fixed instructions",
  hostMcp: { url: "http://127.0.0.1:43123/mcp", token: "test-secret" },
};
it("enables native file checkpoints and limits modes by permission profile", () => {
  expect(claudeOptions(definition, options, "/m.json", "id").enableFileCheckpointing).toBe(true);
  expect(claudeModes(options)).toEqual(["default", "plan"]);
  expect(claudeModes({ ...options, permissionProfile: "workspace_write" })).toEqual([
    "default",
    "acceptEdits",
    "plan",
  ]);
  expect(claudeModes({ ...options, permissionProfile: "full_access" })).toContain("auto");
  expect(claudeSafeModes(options)).toEqual(["default", "plan"]);
  expect(claudeSafeModes({ ...options, permissionProfile: "full_access" })).toEqual([
    "default",
    "plan",
    "acceptEdits",
  ]);
  // Only full access keeps bypassPermissions selectable after a relaunch in another mode.
  expect(claudeOptions(definition, options, "/m.json", "id").allowDangerouslySkipPermissions).toBe(
    false,
  );
  expect(
    claudeOptions(definition, { ...options, permissionProfile: "full_access" }, "/m.json", "id")
      .allowDangerouslySkipPermissions,
  ).toBe(true);
});
it("uses an explicit safe mode, isolated MCP file, and persistent session id", () => {
  const launch = claudeOptions(
    definition,
    options,
    "/work/data/mcp.json",
    "11111111-1111-4111-8111-111111111111",
  );
  expect(launch).toMatchObject({
    pathToClaudeCodeExecutable: "claude",
    sessionId: "11111111-1111-4111-8111-111111111111",
    permissionMode: "default",
    strictMcpConfig: true,
    systemPrompt: { type: "preset", preset: "claude_code", append: "Fixed instructions" },
    disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
    extraArgs: { "mcp-config": "/work/data/mcp.json", "replay-user-messages": null },
  });
  expect(launch.permissionPromptToolName).toBeUndefined();
  expect(launch.persistSession).toBeUndefined();
  expect(launch.mcpServers).toBeUndefined();
  expect(JSON.stringify(launch)).not.toContain("test-secret");
});
it("restores fixed instructions and MCP flags on native resume", () => {
  const launch = claudeOptions(
    definition,
    { ...options, mode: "resume", nativeId: "native-1", permissionProfile: "workspace_write" },
    "/work/data/mcp.json",
    "native-1",
  );
  expect(launch).toMatchObject({
    resume: "native-1",
    permissionMode: "default",
    systemPrompt: { append: "Fixed instructions" },
    extraArgs: { "mcp-config": "/work/data/mcp.json" },
  });
  expect(launch.sessionId).toBeUndefined();
});
it("rejects conflicting definition flags instead of weakening the profile", () => {
  expect(() =>
    claudeOptions(
      { ...definition, launch: { ...definition.launch, args: ["--dangerously-skip-permissions"] } },
      options,
      "/work/data/mcp.json",
      "native",
    ),
  ).toThrow("conflicting_launch_flags");
});

it("serializes managed native skill packaging inside the provider adapter", () => {
  const adapter = new ClaudeAdapter({} as ClaudeHost);
  const layout = adapter.nativeSkillLayout({
    name: "release-notes",
    revision: 3,
    hash: "a".repeat(64),
  });
  expect(layout.prefix).toBe("skills/release-notes");
  expect(layout.namespace).toBe("zoltbot-aaaaaaaaaaaa");
  expect(layout.files).toEqual([
    {
      path: ".claude-plugin/plugin.json",
      content: JSON.stringify({ name: "zoltbot-aaaaaaaaaaaa", version: "1.0.3" }),
    },
  ]);
});

it("rejects an unverified binary version before native fork creation", async () => {
  const adapter = new ClaudeAdapter({
    async probe() {
      return { installed: true, broken: false, version: "unverified", login: "signed_in" };
    },
    async config() {
      throw Error("unexpected_native_configuration");
    },
    async connect() {
      throw Error("unexpected_native_launch");
    },
  });
  await expect(
    adapter.open(definition, {
      ...options,
      mode: "fork",
      fork: {
        sourceNativeId: "source",
        sourceCwd: options.cwd,
        targetNativeId: "child",
        boundary: { kind: "latest" },
      },
    }),
  ).rejects.toThrow("native_fork_unverified");
});

it("keeps the person's own MCP servers only when the session asks for them", () => {
  const own = claudeOptions(definition, { ...options, ownTools: true }, "/m.json", "id");
  expect(own.strictMcpConfig).toBe(false);
  expect(own.extraArgs).toMatchObject({ "mcp-config": "/m.json" });
  expect(own.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit", "Bash"]);
  expect(claudeOptions(definition, options, "/m.json", "id").strictMcpConfig).toBe(true);
  const some = claudeOptions(
    definition,
    { ...options, ownTools: true, ownToolsOff: ["posthog", "gmail"] },
    "/m.json",
    "id",
  );
  expect(some.disallowedTools).toEqual([
    "Edit",
    "Write",
    "NotebookEdit",
    "Bash",
    "mcp__posthog",
    "mcp__gmail",
  ]);
});
