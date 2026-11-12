import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { claudeDefinitions } from "@zoltbot/adapters-claude/definitions";
import { codexDefinitions } from "@zoltbot/adapters-codex/definitions";
import type { AgentAdapter } from "@zoltbot/adapters-sdk";
import { SessionTokens, startHostMcp, ToolDispatcher } from "@zoltbot/hostmcp";
import type { AgentDefinition, HostToolDefinition } from "@zoltbot/protocol";
import type { Redactor } from "../logging.js";
import { NativeRuntimeHost } from "../native-runtime.js";
import type { PrivateVault } from "../private-context.js";
import { providerHosts } from "../provider-hosts.js";
import { type CloudTasksOptions, cloudTasks } from "./task-host.js";
import { taskVault } from "./vault.js";

export type CloudToolSet = ConstructorParameters<typeof ToolDispatcher>[1] & {
  definitions: readonly HostToolDefinition[];
};
type ResourceInput = Parameters<CloudTasksOptions["resources"]>[0];
export interface NativeCloudTasksOptions
  extends Pick<CloudTasksOptions, "orgId" | "memberId" | "workspaces" | "guard" | "status"> {
  directory: string;
  /** Keychain for the Mac, an environment-keyed encrypted vault for the worker. */
  vault(taskId: string, signal: AbortSignal): Promise<PrivateVault>;
  tools(input: ResourceInput): Promise<CloudToolSet>;
  /** Read only from the keychain or injected sandbox environment; never persist this value here. */
  providerKey?(
    provider: "claude" | "codex",
    taskId: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  /** Trusted native discovery ports, also used by the headless protocol fixtures. */
  native?: Omit<Parameters<typeof providerHosts>[0], "directory" | "overrides">;
}
const builtins = new Map(
  [...claudeDefinitions, ...codexDefinitions].map((value) => [value.id, value]),
);
const environmentName = (provider: string) =>
  provider === "claude" ? "ANTHROPIC_API_KEY" : provider === "codex" ? "OPENAI_API_KEY" : undefined;

/** Native process/tool assembly only. Account grants and daemon opt-in belong to its caller. */
export function nativeCloudTasks(options: NativeCloudTasksOptions) {
  const lifetime = new AbortController(),
    active = new Set<() => Promise<void>>();
  const definitions = new Map<string, AgentDefinition>();
  const check = (signal: AbortSignal) => {
    if (lifetime.signal.aborted || signal.aborted) throw new Error("runner_native_unavailable");
  };
  const directory = async (suffix: string) => {
    if (!path.isAbsolute(options.directory)) throw new Error("runner_native_unavailable");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(options.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runner_native_unavailable");
    const root = await realpath(options.directory),
      target = path.join(root, suffix);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const child = await lstat(target);
    if (!child.isDirectory() || child.isSymbolicLink())
      throw new Error("runner_native_unavailable");
    await chmod(target, 0o700);
    return target;
  };
  const task = cloudTasks({
    orgId: options.orgId,
    memberId: options.memberId,
    workspaces: options.workspaces,
    cacheDirectory: path.join(options.directory, "cache"),
    guard: options.guard,
    ...(options.status ? { status: options.status } : {}),
    async definition(id, signal) {
      check(signal);
      const saved = definitions.get(id);
      if (saved) return structuredClone(saved);
      const builtin = builtins.get(id);
      if (!builtin) throw new Error("runner_provider_unavailable");
      const env = environmentName(builtin.adapter);
      if (!env) throw new Error("runner_provider_unavailable");
      const hosts = providerHosts({ ...options.native, directory: await directory("discovery") });
      try {
        const result = await hosts.definition({
          ...structuredClone(builtin),
          auth: { ...builtin.auth, apiKeyEnv: env },
        });
        check(signal);
        definitions.set(id, structuredClone(result));
        return result;
      } finally {
        await hosts.close();
      }
    },
    async resources(input) {
      const signal = AbortSignal.any([lifetime.signal, input.signal]);
      check(signal);
      const taskDirectory = await directory(
        createHash("sha256")
          .update(JSON.stringify([options.orgId, input.lease.taskId]))
          .digest("hex"),
      );
      const hosts = providerHosts({ ...options.native, directory: taskDirectory });
      const tokens = new SessionTokens();
      let mcp: Awaited<ReturnType<typeof startHostMcp>> | undefined,
        closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          tokens.close();
          const results = await Promise.allSettled([hosts.close(), mcp?.close()]);
          active.delete(close);
          if (results.some((result) => result.status === "rejected"))
            throw new Error("runner_native_cleanup_required");
        })());
      try {
        const source = await options.vault(input.lease.taskId, signal);
        check(signal);
        const vault = taskVault(source, { orgId: options.orgId, taskId: input.lease.taskId });
        const ports = await options.tools(input);
        check(signal);
        const definitions = structuredClone([...ports.definitions]);
        const execution = input.lease.execution;
        if (!execution) throw new Error("runner_native_unavailable");
        const dispatcher = new ToolDispatcher(tokens, {
          tools: ports.tools,
          authorize(actor, name, args) {
            const session = input.store.record("session", actor.sessionId);
            const turn = actor.turnId ? input.store.record("turn", actor.turnId) : undefined;
            return (
              !signal.aborted &&
              actor.agentId === execution.profile.id &&
              actor.threadId === execution.thread.id &&
              session?.threadId === actor.threadId &&
              session.state === "running" &&
              turn?.sessionId === actor.sessionId &&
              turn.status === "running" &&
              ports.authorize(actor, name, args)
            );
          },
          checkLimits: ports.checkLimits,
          audit: ports.audit,
        });
        mcp = await startHostMcp({ tokens, dispatcher, tools: definitions });
        check(signal);
        const { referenceTokenEstimate } = await import("@zoltbot/adapters-sdk/tokens");
        const adapters = new Map<string, (redactor: Redactor) => AgentAdapter>(
          ["claude", "codex"].map((provider) => [
            provider,
            (redactor: Redactor) => {
              const adapter = hosts.adapters(redactor).get(provider);
              if (!adapter) throw new Error("runner_provider_unavailable");
              return adapter;
            },
          ]),
        );
        const native = new NativeRuntimeHost({
          hostMcpEnvironment: true,
          adapters,
          estimate: referenceTokenEstimate,
          toolTokens: referenceTokenEstimate(JSON.stringify(definitions)),
          artifactTools: () => structuredClone(definitions),
          contributions: async () => ({ baseCommit: input.baseCommit }),
          workspace: async () => ({
            cwd: input.cwd,
            instructions: input.lease.workspaceInstructions,
          }),
          async bind(identity) {
            check(signal);
            if (
              !mcp ||
              identity.threadId !== execution.thread.id ||
              identity.agentId !== execution.profile.id
            )
              throw new Error("runner_native_unavailable");
            return {
              url: mcp.url,
              token: tokens.issue(identity),
              setTurn: (turnId) => tokens.setTurn(identity.sessionId, turnId),
              async close() {
                tokens.revoke(identity.sessionId);
              },
            };
          },
        });
        active.add(close);
        return {
          secrets: vault,
          host: {
            async prepare(request, redactor) {
              check(signal);
              const provider = request.definition.adapter;
              const env = environmentName(provider);
              if (!env || (provider !== "claude" && provider !== "codex"))
                throw new Error("runner_provider_unavailable");
              const key = await options.providerKey?.(provider, input.lease.taskId, signal);
              check(signal);
              if (key !== undefined && (!key || key.length > 16384 || /[\0\r\n]/.test(key)))
                throw new Error("runner_provider_key_unavailable");
              const definition = structuredClone(request.definition);
              if (key) {
                redactor.register(key);
                redactor.hideFrames();
                definition.launch.env[env] = key;
              }
              const prepared = await native.prepare({ ...request, definition }, redactor);
              return {
                ...prepared,
                ...(key ? { privateValues: [...(prepared.privateValues ?? []), key] } : {}),
              };
            },
          },
          close,
        };
      } catch {
        await close();
        throw new Error("runner_native_unavailable");
      }
    },
  });
  return {
    task,
    async close() {
      lifetime.abort();
      const results = await Promise.allSettled([...active].map((close) => close()));
      if (results.some((result) => result.status === "rejected"))
        throw new Error("runner_native_cleanup_required");
    },
  };
}
