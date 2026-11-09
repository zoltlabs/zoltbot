import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentSession } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
import { Redactor } from "../logging.js";
import { type QuickHostContext, quickHostToolDefinitions, quickHostTools } from "./host-tools.js";
import type { QuickToolRuntime } from "./tools.js";

/**
 * Opens the person's installed coding tools through the regular adapters, read-only, in an empty
 * folder per conversation. With tools on, a session keeps the MCP servers and plugins the person
 * configured in that tool and gets Quick Chat's read-only workspace tools; it never gets
 * Zoltbot's team or workspace-changing tools. Nothing loads until the first Quick Chat request.
 */
export function quickToolRuntime(directory: string): QuickToolRuntime {
  const root = path.join(directory, "quick-chat", "tools");
  let host: QuickHostContext | undefined;
  let loaded:
    | Promise<{
        hosts: ReturnType<typeof import("../provider-hosts.js").providerHosts>;
        tokens: import("@zoltbot/hostmcp").SessionTokens;
        mcp: Awaited<ReturnType<typeof import("@zoltbot/hostmcp").startHostMcp>>;
        enabled: Set<string>;
      }>
    | undefined;
  const load = () =>
    (loaded ??= (async () => {
      const [{ providerHosts }, { SessionTokens, ToolDispatcher, startHostMcp }] =
        await Promise.all([import("../provider-hosts.js"), import("@zoltbot/hostmcp")]);
      const tokens = new SessionTokens();
      const enabled = new Set<string>();
      const dispatcher = new ToolDispatcher(tokens, {
        tools: host ? quickHostTools(host) : new Map(),
        authorize: (actor) => actor.agentId === "quick-chat" && enabled.has(actor.sessionId),
        checkLimits: () => true,
        async audit() {},
      });
      const mcp = await startHostMcp({
        tokens,
        dispatcher,
        tools: host ? quickHostToolDefinitions : [],
        toolsForActor: (actor) =>
          host && enabled.has(actor.sessionId) ? quickHostToolDefinitions : [],
      });
      return { hosts: providerHosts({ directory }), tokens, mcp, enabled };
    })());
  return {
    attach(context) {
      host = context;
    },
    async open(definition: AgentDefinition, options): Promise<AgentSession> {
      const { hosts, tokens, mcp, enabled } = await load();
      const resolved = await hosts.definition(definition);
      const adapter = hosts.adapters(new Redactor()).get(resolved.adapter);
      if (!adapter) throw new Error("runtime_adapter_unavailable");
      const cwd = path.join(root, options.conversationId.replace(/[^\w-]/g, "_"));
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const identity = { agentId: "quick-chat", threadId: options.conversationId };
      const sessionId = randomUUID();
      const token = tokens.issue({ ...identity, sessionId });
      if (options.tools) enabled.add(sessionId);
      return adapter.open(resolved, {
        identity,
        mode: "new",
        cwd,
        ...(options.model ? { model: options.model } : {}),
        permissionProfile: "read_only",
        ...(options.instructions ? { appendInstructions: options.instructions } : {}),
        hostMcp: { url: mcp.url, token },
        ...(options.tools ? { ownTools: true, ownToolsOff: options.off ?? [] } : {}),
        name: "Quick Chat",
      });
    },
    async close() {
      if (!loaded) return;
      const { hosts, mcp } = await loaded.catch(() => ({ hosts: undefined, mcp: undefined }));
      await mcp?.close();
      await hosts?.close();
    },
  };
}
