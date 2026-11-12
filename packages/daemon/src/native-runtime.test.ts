import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentAdapter, AgentSession, OpenOptions } from "@zoltbot/adapters-sdk";
import { AsyncQueue } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, AgentEvent, Profile, Thread } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { Redactor } from "./logging.js";
import { NativeRuntimeHost } from "./native-runtime.js";

function fixture(provider = "synthetic", hostMcpEnvironment = false) {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/native-runtime-"));
  const definition: AgentDefinition = {
    id: "fixture",
    adapter: provider,
    displayName: "Synthetic",
    binaryNames: [],
    versionCommand: [],
    launch: { command: "synthetic", args: [], env: { HOME: root } },
    testedVersions: "fixture",
    defaults: { permissionProfile: "read_only" },
    staticCapabilities: {},
    nativeSessionRoots: [],
    experimental: false,
  };
  const profile: Profile = {
    id: "profile",
    name: "Fixture",
    avatar: "F",
    kind: "profile",
    definitionId: definition.id,
    permissionProfile: "read_only",
    instructions: "Saved instructions",
    roleText: "Saved role",
    model: "model-a",
    effort: "low",
    hidden: false,
    archived: false,
  };
  const thread: Thread = {
    id: "thread",
    agentId: profile.id,
    kind: "main",
    title: "Fixture",
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: "2026-10-29T00:00:00Z",
    lastActivityAt: "2026-10-29T00:00:00Z",
  };
  const trace: string[] = [],
    events = new AsyncQueue<AgentEvent>();
  let opened: OpenOptions | undefined,
    failure = false,
    closeFailure = false;
  const session = {
    nativeId: "native",
    capabilities: {},
    events: () => events,
    async send() {
      return { disposition: "started" as const };
    },
    async close() {
      trace.push("native.close");
      if (closeFailure) throw new Error("close failed");
      events.close();
    },
  } as unknown as AgentSession;
  const adapter = {
    id: provider,
    async open(_definition: AgentDefinition, options: OpenOptions) {
      trace.push("native.open");
      opened = options;
      if (failure) throw new Error("auth_required");
      return session;
    },
  } as unknown as AgentAdapter;
  const redactor = new Redactor();
  const host = new NativeRuntimeHost({
    hostMcpEnvironment,
    adapters: new Map([
      [
        adapter.id,
        () => {
          trace.push("adapter");
          return adapter;
        },
      ],
    ]),
    workspace: async () => ({ cwd: root, instructions: "Project context" }),
    estimate: (text) => text.length,
    toolTokens: 10,
    async bind(identity) {
      trace.push(`binding:${identity.sessionId}`);
      return {
        url: "http://127.0.0.1:1234/mcp",
        token: "synthetic-session-token",
        setTurn() {},
        async close() {
          trace.push("binding.close");
        },
      };
    },
  });
  return {
    root,
    definition,
    profile,
    thread,
    trace,
    redactor,
    host,
    session,
    opened: () => opened,
    failOpen: () => {
      failure = true;
    },
    failClose: (value: boolean) => {
      closeFailure = value;
    },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
it("opts cloud hosts into environment MCP credentials without persisting the token in their configuration", async () => {
  const f = fixture("synthetic", true);
  try {
    const prepared = await f.host.prepare(f, f.redactor);
    const session = await prepared.open({ sessionId: "session", mode: "new" });
    expect(f.opened()?.hostMcp.tokenEnv).toBe("ZOLTBOT_HOST_MCP_TOKEN");
    expect(f.opened()?.env?.ZOLTBOT_HOST_MCP_TOKEN).toBe(f.opened()?.hostMcp.token);
    expect(JSON.stringify(prepared.configuration).includes("synthetic-session-token")).toBe(false);
    await session.close();
  } finally {
    f.clean();
  }
});
it("prepares without native side effects and opens the exact saved profile with a scoped binding", async () => {
  const f = fixture();
  try {
    const prepared = await f.host.prepare(f, f.redactor);
    expect(f.trace).toEqual([]);
    expect(prepared.fixedInjectedTokens).toBe(57);
    f.profile.instructions = "mutated later";
    const session = await prepared.open({ sessionId: "session", mode: "new" });
    expect(f.opened()).toMatchObject({
      identity: { agentId: "profile", threadId: "thread" },
      cwd: f.root,
      permissionProfile: "read_only",
      model: "model-a",
      effort: "low",
      appendInstructions: "Saved role\n\nSaved instructions\n\nProject context",
    });
    expect(f.redactor.text("synthetic-session-token")).toBe("[redacted]");
    await session.close();
    await session.close();
    expect(f.trace).toEqual([
      "binding:session",
      "adapter",
      "native.open",
      "binding.close",
      "native.close",
    ]);
    await expect(prepared.open({ sessionId: "again", mode: "new" })).rejects.toThrow(
      "runtime_preparation_consumed",
    );
  } finally {
    f.clean();
  }
});
it("releases bindings after failed open and revokes access even when native cleanup needs retry", async () => {
  const f = fixture();
  try {
    f.failOpen();
    const prepared = await f.host.prepare(f, f.redactor);
    await expect(prepared.open({ sessionId: "session", mode: "new" })).rejects.toThrow(
      "auth_required",
    );
    expect(f.trace.at(-1)).toBe("binding.close");
  } finally {
    f.clean();
  }
  const second = fixture();
  try {
    const prepared = await second.host.prepare(second, second.redactor);
    const session = await prepared.open({ sessionId: "session", mode: "new" });
    second.failClose(true);
    await expect(session.close()).rejects.toThrow("close failed");
    expect(second.trace).toContain("binding.close");
    second.failClose(false);
    await session.close();
    expect(second.trace.filter((entry) => entry === "binding.close")).toHaveLength(1);
    expect(second.trace.filter((entry) => entry === "native.close")).toHaveLength(2);
  } finally {
    second.clean();
  }
});
it("rejects replaced workspaces, mismatched resume paths, unsupported adapters and excessive fixed injection before opening", async () => {
  const f = fixture();
  try {
    await expect(
      f.host.prepare(
        {
          ...f,
          previous: { nativeId: "native", cwd: path.dirname(f.root), provider: "synthetic" },
        },
        f.redactor,
      ),
    ).rejects.toThrow("native_cwd_changed");
    await expect(
      f.host.prepare({ ...f, definition: { ...f.definition, adapter: "missing" } }, f.redactor),
    ).rejects.toThrow("runtime_adapter_unavailable");
    await expect(
      f.host.prepare(
        { ...f, profile: { ...f.profile, instructions: "x".repeat(2000) } },
        f.redactor,
      ),
    ).rejects.toThrow("injection_fixed_budget_exceeded");
    const prepared = await f.host.prepare(f, f.redactor);
    renameSync(f.root, `${f.root}-old`);
    mkdirSync(f.root);
    await expect(prepared.open({ sessionId: "session", mode: "new" })).rejects.toThrow(
      "runtime_workspace_changed",
    );
    expect(f.trace).toEqual([]);
  } finally {
    f.clean();
    rmSync(`${f.root}-old`, { recursive: true, force: true });
  }
});

it("restores the original native session profile instead of applying later profile edits on resume", async () => {
  const f = fixture();
  try {
    const first = await f.host.prepare(f, f.redactor);
    const saved = structuredClone(first.configuration);
    f.profile.model = "later-model";
    f.profile.instructions = "Later instructions";
    f.profile.permissionProfile = "full_access";
    const resumed = await f.host.prepare(
      {
        ...f,
        previous: { nativeId: "native", provider: "synthetic", cwd: f.root, configuration: saved },
      },
      f.redactor,
    );
    const session = await resumed.open({
      sessionId: "resumed",
      mode: "resume",
      nativeId: "native",
    });
    expect(f.opened()).toMatchObject({
      model: "model-a",
      permissionProfile: "read_only",
      appendInstructions: expect.stringContaining("Saved instructions"),
    });
    expect(f.opened()?.appendInstructions).not.toContain("Later instructions");
    await session.close();
  } finally {
    f.clean();
  }
});

it("reserves native writers across adapter factories and releases only after physical close", async () => {
  const f = fixture();
  try {
    const input = { ...f, previous: { nativeId: "native", cwd: f.root, provider: "synthetic" } };
    const first = await f.host.prepare(input, f.redactor),
      second = await f.host.prepare(input, f.redactor);
    const session = await first.open({ sessionId: "first", mode: "resume", nativeId: "native" });
    await expect(
      second.open({ sessionId: "second", mode: "resume", nativeId: "native" }),
    ).rejects.toThrow("native_session_in_use");
    f.failClose(true);
    await expect(session.close()).rejects.toThrow();
    const third = await f.host.prepare(input, f.redactor);
    await expect(
      third.open({ sessionId: "third", mode: "resume", nativeId: "native" }),
    ).rejects.toThrow("native_session_in_use");
    f.failClose(false);
    await session.close();
    const replacement = await f.host.prepare(input, f.redactor);
    await (
      await replacement.open({ sessionId: "replacement", mode: "resume", nativeId: "native" })
    ).close();
  } finally {
    f.clean();
  }
});

it("treats an implicit CLI home like its explicit default while refusing a different provider folder", async () => {
  const f = fixture("claude");
  try {
    const prepared = await f.host.prepare(f, f.redactor);
    const input = {
      ...f,
      previous: {
        nativeId: "native",
        cwd: f.root,
        provider: "claude",
        configuration: prepared.configuration,
      },
    };
    const definition = {
      ...f.definition,
      launch: {
        ...f.definition.launch,
        env: { ...f.definition.launch.env, CLAUDE_CONFIG_DIR: path.join(f.root, ".claude") },
      },
    };
    await expect(f.host.prepare({ ...input, definition }, f.redactor)).resolves.toMatchObject({
      cwd: f.root,
    });
    await expect(
      f.host.prepare(
        {
          ...input,
          definition: {
            ...definition,
            launch: {
              ...definition.launch,
              env: {
                ...definition.launch.env,
                CLAUDE_CONFIG_DIR: path.join(f.root, "another-account"),
              },
            },
          },
        },
        f.redactor,
      ),
    ).rejects.toThrow("native_configuration_changed");
  } finally {
    f.clean();
  }
});

it("resumes configurations saved before ACP home metadata was added", async () => {
  const f = fixture("claude");
  try {
    const prepared = await f.host.prepare(f, f.redactor);
    const configuration = structuredClone(prepared.configuration) as {
      providerHome: Record<string, unknown>;
    };
    for (const key of ["GEMINI_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"])
      delete configuration.providerHome[key];
    await expect(
      f.host.prepare(
        { ...f, previous: { nativeId: "native", cwd: f.root, provider: "claude", configuration } },
        f.redactor,
      ),
    ).resolves.toMatchObject({ cwd: f.root });
  } finally {
    f.clean();
  }
});

it("fences the same ACP flavor across definition aliases while allowing another flavor", async () => {
  const f = fixture();
  try {
    const first = await f.host.prepare(
      { ...f, definition: { ...f.definition, flavor: "first" } },
      f.redactor,
    );
    const session = await first.open({ sessionId: "one", mode: "resume", nativeId: "native" });
    const alias = await f.host.prepare(
      { ...f, definition: { ...f.definition, id: "alias", flavor: "first" } },
      f.redactor,
    );
    await expect(
      alias.open({ sessionId: "two", mode: "resume", nativeId: "native" }),
    ).rejects.toThrow("native_session_in_use");
    const other = await f.host.prepare(
      { ...f, definition: { ...f.definition, flavor: "second" } },
      f.redactor,
    );
    const otherSession = await other.open({
      sessionId: "three",
      mode: "resume",
      nativeId: "native",
    });
    await otherSession.close();
    await session.close();
  } finally {
    f.clean();
  }
});

it("applies the Compare permission ceiling without adding any injected tokens", async () => {
  const f = fixture();
  try {
    const profile = { ...f.profile, permissionProfile: "workspace_write" as const };
    const normal = await f.host.prepare({ ...f, profile }, f.redactor);
    const compare = await f.host.prepare(
      { ...f, profile, comparePermission: "read_only" },
      f.redactor,
    );
    expect(compare.fixedInjectedTokens).toBe(normal.fixedInjectedTokens);
    const native = await compare.open({ sessionId: "compare", mode: "new" });
    expect(f.opened()?.permissionProfile).toBe("read_only");
    await native.close();
  } finally {
    f.clean();
  }
});

it("keeps Compare read-only on native resume even when the frozen profile allowed writes", async () => {
  const f = fixture();
  try {
    const profile = { ...f.profile, permissionProfile: "workspace_write" as const };
    const initial = await f.host.prepare({ ...f, profile }, f.redactor);
    const resumed = await f.host.prepare(
      {
        ...f,
        profile,
        comparePermission: "read_only",
        previous: {
          nativeId: "saved",
          cwd: f.root,
          provider: f.definition.adapter,
          configuration: initial.configuration,
        },
      },
      f.redactor,
    );
    const native = await resumed.open({
      sessionId: "resumed-compare",
      mode: "resume",
      nativeId: "saved",
    });
    expect(f.opened()?.permissionProfile).toBe("read_only");
    expect(resumed.fixedInjectedTokens).toBe(initial.fixedInjectedTokens);
    await native.close();
  } finally {
    f.clean();
  }
});

it("throws injection_fixed_budget_exceeded before composeLaunchManifest can misreport context_budget_hold", async () => {
  const f = fixture();
  const { composeLaunchManifest } = await import("../../connections/src/launch-manifest.js");
  try {
    const hostWithExtensions = new NativeRuntimeHost({
      adapters: new Map([
        [
          f.definition.adapter,
          () =>
            ({
              id: f.definition.adapter,
              manifest: () => ({
                supportsConnections: true,
                supportsNativeSkills: false,
                supportsLocalBrowserCli: false,
              }),
              async open() {
                throw new Error("should_not_open");
              },
            }) as unknown as AgentAdapter,
        ],
      ]),
      workspace: async () => ({ cwd: f.root, instructions: "Workspace instructions" }),
      estimate: (text) => Math.ceil(text.length / 4),
      toolTokens: 950,
      extensions: {
        select: () => [],
        compose: (identity, contributions) =>
          composeLaunchManifest(
            {
              executionId: "exec-1",
              threadId: identity.threadId,
              profileId: identity.profileId,
              cwd: identity.cwd,
              configurationHash: "cfg",
            },
            contributions,
            { limit: 1500, fixed: identity.fixed },
          ),
        resolve: async () => [],
      },
      bind: async () => ({
        url: "http://127.0.0.1:1/mcp",
        token: "token",
        setTurn() {},
        async close() {},
      }),
    });
    await expect(
      hostWithExtensions.prepare(
        {
          ...f,
          profile: { ...f.profile, instructions: "x".repeat(2600) },
        },
        f.redactor,
      ),
    ).rejects.toThrow("injection_fixed_budget_exceeded");
  } finally {
    f.clean();
  }
});
