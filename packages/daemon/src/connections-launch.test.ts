import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentAdapter, AgentSession, OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, Profile, Thread } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import type { LaunchManifest } from "../../connections/src/launch-manifest.js";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { connectionsRuntime } from "./connections-runtime.js";
import { Redactor } from "./logging.js";
import { NativeRuntimeHost } from "./native-runtime.js";

it("freezes scoped connection versions and exact knowledge bytes through native resume; revocation fails closed", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/connections-launch-"));
  const store = await openStore(path.join(root, "test.db"));
  const registry = new ConnectionRegistry(store.database);
  const reference = "keychain:zoltbot:00000000-0000-4000-8000-000000000000";
  const selected = registry.save(
    {
      id: "app",
      name: "app",
      version: 1,
      projectId: "project",
      transport: { kind: "https", url: "https://service.example/mcp" },
      credentialReference: reference,
      enabled: true,
      profileIds: ["profile"],
      source: "manual",
      credentialStatus: "connected",
      health: "not_checked",
      schemaTokens: { value: 512, source: "estimated" },
    },
    0,
    true,
  );
  const opened: OpenOptions[] = [];
  const adapter = {
    manifest: () => ({ supportsConnections: true }),
    open: async (_definition: AgentDefinition, options: OpenOptions) => {
      opened.push(options);
      return { nativeId: "native", close: async () => {} } as AgentSession;
    },
  } as AgentAdapter;
  const input = {
    thread: { id: "thread", agentId: "profile", projectId: "project" } as Thread,
    profile: {
      id: "profile",
      name: "Test",
      avatar: "T",
      kind: "profile",
      hidden: false,
      archived: false,
      definitionId: "provider",
      permissionProfile: "read_only",
      instructions: "initial",
    } as Profile,
    definition: { id: "provider", adapter: "synthetic", launch: { env: {} } } as AgentDefinition,
  };
  let text = "exact frozen knowledge v1";
  const runtime = new NativeRuntimeHost({
    adapters: new Map([["synthetic", () => adapter]]),
    workspace: async () => ({ cwd: root }),
    toolTokens: 5,
    estimate: (s) => Math.ceil(s.length / 3),
    extensions: connectionsRuntime(store, {
      read: async () => ({
        resource: "https://service.example/mcp",
        issuer: "https://issuer.example",
        accessToken: "SENTINEL_CONNECTION_PRIVATE",
      }),
      put: async () => ({ reference }),
    }),
    contributions: async () => ({ knowledge: { packId: "pack-v1", text, tokens: 10 } }),
    bind: async () => ({
      url: "http://127.0.0.1/mcp",
      token: "host-token",
      setTurn() {},
      close: async () => {},
    }),
  });
  try {
    const redactor = new Redactor();
    const prepared = await runtime.prepare(input, redactor);
    const manifest = prepared.configuration?.launchManifest as LaunchManifest;
    const narrowed = await runtime.prepare(
      { ...input, routineInputs: { knowledge: "inherit", skills: "inherit", connections: [] } },
      redactor,
    );
    expect((narrowed.configuration?.launchManifest as LaunchManifest).connections).toEqual([]);
    expect(manifest.connections[0]?.version).toBe(1);
    expect(JSON.stringify(prepared.configuration)).not.toContain("SENTINEL_CONNECTION_PRIVATE");
    expect(prepared.privateValues).toEqual(["SENTINEL_CONNECTION_PRIVATE"]);
    const native = await prepared.open({ sessionId: "first", mode: "new" });
    await native.close();
    const legacy = { ...prepared.configuration };
    delete legacy.launchManifest;
    const legacyResume = await runtime.prepare(
      {
        ...input,
        previous: { nativeId: "native", cwd: root, provider: "synthetic", configuration: legacy },
      },
      redactor,
    );
    expect(legacyResume.configuration?.launchManifest).toBeUndefined();
    expect(legacyResume.firstTurnKnowledge).toBeUndefined();
    await expect(
      runtime.prepare(
        {
          ...input,
          definition: {
            ...input.definition,
            launch: { ...input.definition.launch, args: ["--changed-definition"] },
          },
          previous: {
            nativeId: "native",
            cwd: root,
            provider: "synthetic",
            configuration: prepared.configuration,
          },
        },
        redactor,
      ),
    ).rejects.toThrow("native_configuration_changed");
    text = "new knowledge v2";
    registry.save(
      { ...selected, schemaTokens: { value: 600, source: "estimated" } },
      selected.version,
    );
    const resumed = await runtime.prepare(
      {
        ...input,
        routineInputs: { knowledge: [], skills: [], connections: [] },
        previous: {
          nativeId: "native",
          cwd: root,
          provider: "synthetic",
          configuration: prepared.configuration,
        },
      },
      redactor,
    );
    expect(resumed.configuration?.launchManifest).toEqual(manifest);
    expect(resumed.firstTurnKnowledge?.text).toBe("exact frozen knowledge v1");
    const handle = await resumed.open({ sessionId: "second", mode: "resume", nativeId: "native" });
    await handle.close();
    expect(opened[1]?.connections?.[0]).toMatchObject({
      name: "app",
      headers: { Authorization: "Bearer SENTINEL_CONNECTION_PRIVATE" },
    });
    expect(opened[1]?.hostMcp.token).toBe("host-token");
    const beforeNarrow = registry.get("app");
    registry.save({ ...beforeNarrow, profileIds: [], enabled: false }, beforeNarrow.version);
    const retained = await runtime.prepare(
      {
        ...input,
        previous: {
          nativeId: "native",
          cwd: root,
          provider: "synthetic",
          configuration: prepared.configuration,
        },
      },
      redactor,
    );
    expect(retained.configuration?.launchManifest).toEqual(manifest);
    const current = registry.get("app");
    registry.save(
      { ...current, enabled: false, revokedThroughVersion: current.version },
      current.version,
    );
    await expect(
      runtime.prepare(
        {
          ...input,
          previous: {
            nativeId: "native",
            cwd: root,
            provider: "synthetic",
            configuration: prepared.configuration,
          },
        },
        redactor,
      ),
    ).rejects.toThrow("connection_revoked");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
