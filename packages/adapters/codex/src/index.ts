import { type AgentAdapter, NativeWriters, type OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, NativeSessionInfo } from "@zoltbot/protocol";
import { codexConnections } from "./connections.js";
import type { CodexHost } from "./host.js";
import { CodexRpc } from "./rpc.js";
import { CodexSchemas, object } from "./schema.js";
import { CodexSession } from "./session.js";

export * from "./host.js";
export interface CodexPeer {
  rpc: CodexRpc;
  owners: Map<string, CodexSession>;
  providerVersion: string;
  release(): Promise<void>;
}
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  private readonly writers = new NativeWriters();
  private readonly peers = new Map<string, Promise<CodexPeer>>();
  constructor(
    private readonly host: CodexHost,
    private readonly timeoutMs = 30000,
  ) {}
  manifest() {
    return {
      id: this.id,
      displayName: "Codex",
      testedVersions: "0.164.0",
      binaryNames: ["codex"],
      versionCommand: ["--version"],
      supportsConnections: true,
      supportsLocalBrowserCli: true,
      staticCapabilities: {
        resume: true,
        fork: true,
        steer: "native" as const,
        concurrentTurns: false,
      },
    };
  }
  probe(definition: AgentDefinition) {
    return this.host.probe(definition);
  }
  private async acquire(definition: AgentDefinition, options: Pick<OpenOptions, "cwd" | "env">) {
    const key = JSON.stringify([
      definition.id,
      options.env?.CODEX_HOME ?? definition.launch.env.CODEX_HOME,
    ]);
    let promise = this.peers.get(key);
    if (!promise) {
      promise = (async () => {
        const probe = await this.host.probe(definition);
        if (!probe.installed) throw new Error("binary_not_found");
        if (probe.broken) throw new Error("binary_broken");
        const schemas = new CodexSchemas(await this.host.schema(definition));
        const launchDefinition = structuredClone(definition);
        if (!launchDefinition.launch.args.includes("app-server"))
          launchDefinition.launch.args.push("app-server");
        const transport = await this.host.connect(launchDefinition, options);
        const rpc = new CodexRpc(transport, schemas, this.timeoutMs);
        const owners = new Map<string, CodexSession>();
        let users = 0;
        rpc.on("notification", (message: Record<string, unknown>) => {
          for (const owner of owners.values())
            void owner.receive(String(message.method), object(message.params));
        });
        rpc.on("server_request", (message: Record<string, unknown>) => {
          const params = object(message.params);
          const owner = owners.get(String(params.threadId));
          if (owner) void owner.serverRequest(message);
          else if (typeof message.id === "string" || typeof message.id === "number")
            void rpc.reject(message.id).catch(() => {});
        });
        rpc.on("fault", (code: string) => {
          if (this.peers.get(key) === promise) this.peers.delete(key);
          for (const owner of owners.values()) void owner.fail(code);
        });
        try {
          const result = await rpc.initialize(true);
          if (result.account.requiresOpenaiAuth === true && !result.account.account)
            throw new Error("auth_required");
          return {
            rpc,
            owners,
            providerVersion: probe.version ?? result.providerVersion,
            retain() {
              users++;
            },
            async release() {
              if (--users === 0) {
                await rpc.close();
              }
            },
          };
        } catch (error) {
          await rpc.close();
          throw error;
        }
      })().catch((error: unknown) => {
        if (this.peers.get(key) === promise) this.peers.delete(key);
        throw error;
      });
      this.peers.set(key, promise);
    }
    const peer = (await promise) as CodexPeer & { retain(): void };
    peer.retain();
    return peer;
  }
  async open(definition: AgentDefinition, options: OpenOptions) {
    let peer: CodexPeer | undefined;
    let session: CodexSession | undefined;
    let releaseWriter: (() => void) | undefined;
    const writerKey = (nativeId: string) =>
      JSON.stringify([
        this.id,
        options.env?.CODEX_HOME ?? definition.launch.env.CODEX_HOME,
        nativeId,
      ]);
    try {
      if (options.mode !== "new" && !options.nativeId && !options.fork?.sourceNativeId)
        throw new Error("native_id_required");
      if (options.mode === "resume" && options.nativeId)
        releaseWriter = this.writers.acquire(writerKey(options.nativeId));
      peer = await this.acquire(definition, options);
      if (options.mode === "fork" && options.fork && peer.providerVersion !== "0.166.0")
        throw new Error("native_fork_unverified");
      this.host.privateRead?.();
      const effectiveConfig = await peer.rpc.request("config/read", {
        includeLayers: false,
        cwd: options.cwd,
      });
      const full = options.permissionProfile === "full_access";
      const params = {
        cwd: options.cwd,
        sandbox: full
          ? "danger-full-access"
          : options.permissionProfile === "read_only"
            ? "read-only"
            : "workspace-write",
        approvalPolicy: full ? "never" : "on-request",
        ...(options.model ? { model: options.model } : {}),
        ...(options.appendInstructions
          ? { developerInstructions: options.appendInstructions }
          : {}),
        config: {
          mcp_servers: codexConnections(effectiveConfig, options),
          ...(options.permissionProfile === "workspace_write_net"
            ? { sandbox_workspace_write: { network_access: true } }
            : {}),
          ...(options.effort ? { model_reasoning_effort: options.effort } : {}),
        },
      };
      const method =
        options.mode === "new"
          ? "thread/start"
          : options.mode === "resume"
            ? "thread/resume"
            : "thread/fork";
      const response = object(
        await peer.rpc.request(method, {
          ...params,
          ...(options.mode === "new"
            ? { serviceName: "zoltbot" }
            : {
                threadId: options.fork?.sourceNativeId ?? options.nativeId,
                excludeTurns: true,
                ...(options.mode === "fork" ? { deferGoalContinuation: true } : {}),
                ...(options.fork?.boundary.kind === "before_user"
                  ? { beforeTurnId: options.fork.boundary.nativeId }
                  : {}),
                ...(options.fork?.boundary.kind === "after_turn"
                  ? { lastTurnId: options.fork.boundary.nativeId }
                  : {}),
              }),
        }),
      );
      const nativeId = object(response.thread).id;
      if (typeof nativeId !== "string" || !nativeId || peer.owners.has(nativeId))
        throw new Error("provider_protocol_error");
      releaseWriter ??= this.writers.acquire(writerKey(nativeId));
      session = new CodexSession(peer, nativeId, options, this.timeoutMs, releaseWriter);
      peer.owners.set(nativeId, session);
      await session.ready();
      const models = await this.models(peer);
      if (models) {
        session.capabilities.models.list = models.list;
        session.capabilities.effort = models.effort;
      }
      return session;
    } catch (error) {
      if (session) await session.close();
      else {
        releaseWriter?.();
        await peer?.release();
      }
      throw error;
    }
  }
  /** The account's selectable models and their efforts. Listing models starts no inference. */
  private async models(peer: CodexPeer) {
    try {
      const response = object(await peer.rpc.request("model/list", {}));
      return codexModelOptions(Array.isArray(response.data) ? response.data : []);
    } catch {
      return undefined;
    }
  }
  async listNativeSessions(
    definition: AgentDefinition,
    filter: { cwd?: string },
  ): Promise<NativeSessionInfo[]> {
    const peer = await this.acquire(definition, { cwd: filter.cwd ?? process.cwd() });
    const found: NativeSessionInfo[] = [];
    try {
      let cursor: string | undefined;
      do {
        const response = object(
          await peer.rpc.request("thread/list", {
            limit: 100,
            sourceKinds: peer.rpc.schemas.sourceKinds,
            ...(filter.cwd ? { cwd: filter.cwd } : {}),
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const value of Array.isArray(response.data) ? response.data : []) {
          const thread = object(value);
          const nativeId = String(thread.id);
          const owner = peer.owners.get(nativeId);
          found.push({
            provider: this.id,
            nativeId,
            ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
            ...(typeof thread.name === "string"
              ? { title: thread.name }
              : typeof thread.preview === "string"
                ? { title: thread.preview.slice(0, 200) }
                : {}),
            ...(typeof thread.updatedAt === "number"
              ? { lastActivityAt: new Date(thread.updatedAt * 1000).toISOString() }
              : {}),
            ...(owner ? { threadId: owner.options.identity.threadId } : {}),
            ...(typeof thread.source === "string" ? { source: thread.source } : {}),
            adopted: Boolean(owner),
            missing: false,
            lastSeenAt: new Date().toISOString(),
          });
        }
        cursor = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
      } while (cursor);
      return found;
    } finally {
      await peer.release();
    }
  }
}

/**
 * The visible models from Codex's model/list, and every reasoning effort some model accepts
 * (listed as strings or as { reasoningEffort }).
 */
export function codexModelOptions(data: unknown[]) {
  const rows = data
    .map(object)
    .filter((row) => row.hidden !== true && typeof row.id === "string" && row.id);
  const effort = new Set<string>();
  for (const row of rows)
    for (const option of Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts
      : []) {
      const value = typeof option === "string" ? option : object(option).reasoningEffort;
      if (typeof value === "string" && value) effort.add(value);
    }
  return {
    list: rows.map((row) => ({ id: String(row.id), name: String(row.displayName ?? row.id) })),
    effort: [...effort],
  };
}
