import path from "node:path";
import type { AgentAdapter } from "@zoltbot/adapters-sdk";
import type { SessionTokens, startHostMcp } from "@zoltbot/hostmcp";
import { knowledgeScopeHash } from "@zoltbot/knowledge";
import { AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import type { OwnedRuntime, RuntimeContext } from "./api.js";
import { createArtifactBinding } from "./artifacts/binding.js";
import { ownedBrowser } from "./browser/evidence.js";
import { browserObserver } from "./browser/observation.js";
import { browserBinding, browserReadiness } from "./browser/runtime.js";
import { isChief } from "./chief/identity.js";
import { connectionsRuntime } from "./connections-runtime.js";
import { CuaRuntime } from "./cua/runtime.js";
import { knowledgeLaunch } from "./knowledge-launch.js";
import type { Redactor } from "./logging.js";
import type { providerHosts } from "./provider-hosts.js";
import { skillsRuntime } from "./skills-runtime.js";

/** Delay tokenization, native hosts and MCP until a user connects a chat. */
export function productionRuntime(
  context: RuntimeContext,
  directory: string,
  options: { hosts?: ReturnType<typeof providerHosts>; waitMs?: number } = {},
): OwnedRuntime {
  let loaded:
    | Promise<{
        host: import("./session-manager.js").RuntimeHost;
        hosts: ReturnType<typeof providerHosts>;
        mcp: Awaited<ReturnType<typeof startHostMcp>>;
        tokens: SessionTokens;
        cua: CuaRuntime;
      }>
    | undefined;
  let closed = false;
  const load = () =>
    (loaded ??= (async () => {
      if (closed) throw new Error("runtime_closed");
      const [
        { referenceTokenEstimate },
        { NativeRuntimeHost },
        { SessionTokens, startHostMcp, ToolDispatcher },
        { providerHosts },
        { runtimeWorkspace },
        {
          runtimeToolDefinitions,
          browserRuntimeToolDefinitions,
          allRuntimeToolDefinitions,
          artifactRuntimeToolDefinitions,
          artifactBrowserToolDefinitions,
          indirectRuntimeToolDefinitions,
          chiefProviderToolDefinitions,
          runtimeTools,
        },
      ] = await Promise.all([
        import("@zoltbot/adapters-sdk/tokens"),
        import("./native-runtime.js"),
        import("@zoltbot/hostmcp"),
        import("./provider-hosts.js"),
        import("./runtime-workspace.js"),
        import("./runtime-tools.js"),
      ]);
      const hosts =
        options.hosts ??
        providerHosts({
          directory,
          overrides: () => {
            const value = context.store
              .snapshot(["settings"])
              .settings?.find((row) => row.key === "detect.overrides")?.value;
            return value && typeof value === "object" && !Array.isArray(value)
              ? (value as Record<string, string>)
              : {};
          },
        });
      const tokens = new SessionTokens();
      const cua = new CuaRuntime(context);
      const dispatcher = new ToolDispatcher(
        tokens,
        runtimeTools(context, {
          cua,
          ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
        }),
      );
      const mcp = await startHostMcp({
        tokens,
        dispatcher,
        tools: allRuntimeToolDefinitions,
        toolsForActor(actor) {
          const configuration = context.store.record(
            "settings",
            `runtime.configuration.${actor.sessionId}`,
          )?.value as
            | { launchManifest?: { hostTools?: import("@zoltbot/protocol").HostToolDefinition[] } }
            | undefined;
          if (configuration?.launchManifest?.hostTools)
            return configuration.launchManifest.hostTools;
          if (isChief(context.store, actor.threadId)) return chiefProviderToolDefinitions;
          let browser = false;
          try {
            ownedBrowser(context.store, actor);
            browser = true;
          } catch {}
          return browser ? browserRuntimeToolDefinitions : runtimeToolDefinitions;
        },
      });
      const adapters = new Map<string, (redactor: Redactor) => AgentAdapter>(
        ["claude", "codex", "acp"].map((provider) => [
          provider,
          (redactor: Redactor) => {
            const adapter = hosts.adapters(redactor).get(provider);
            if (!adapter) throw new Error("runtime_adapter_unavailable");
            return adapter;
          },
        ]),
      );
      const skills = skillsRuntime(context.store, path.join(directory, "runtime", "skills"));
      const native = new NativeRuntimeHost({
        adapters,
        artifactTools: (artifact, browser, thread) =>
          // The chief coordinates other chats; it has its own tools and makes no artifacts.
          thread && isChief(context.store, thread.id)
            ? structuredClone(chiefProviderToolDefinitions)
            : structuredClone([
                ...(artifact
                  ? browser
                    ? artifactBrowserToolDefinitions
                    : artifactRuntimeToolDefinitions
                  : browser
                    ? browserRuntimeToolDefinitions
                    : runtimeToolDefinitions),
                ...(browser ? [] : indirectRuntimeToolDefinitions),
              ]),
        prepareArtifacts(input, cwd) {
          if (isChief(context.store, input.thread.id)) return undefined;
          const project = input.thread.projectId
            ? context.store.record("project", input.thread.projectId)
            : undefined;
          const roots = project?.roots as unknown[] | undefined;
          const task = input.thread.taskId
            ? context.store.record("task", input.thread.taskId)
            : undefined;
          const workspace =
            typeof task?.workspaceId === "string"
              ? context.store.record("workspace", task.workspaceId)
              : undefined;
          return createArtifactBinding(cwd, roots?.length || workspace ? cwd : undefined);
        },
        observeBrowser: (executionId, sessionId) =>
          browserObserver(context.store, executionId, sessionId),
        async prepareBrowser(input, cwd) {
          const task = input.thread.taskId
            ? context.store.record("task", input.thread.taskId)
            : undefined;
          const selection = task?.browser as
            | import("./browser/runtime.js").BrowserSelection
            | undefined;
          if (!selection) return undefined;
          if (input.profile.permissionProfile === "read_only")
            throw new Error("browser_requires_shell_workspace_write_profile");
          if ((await browserReadiness(directory)).state !== "ready")
            throw new Error("browser_setup_required");
          return browserBinding(directory, cwd, selection);
        },
        extensions: connectionsRuntime(context.store, context.secrets, (secret) =>
          context.privacy.remember(secret),
        ),
        materializeSkills: (manifest, layout) => skills.materialize(manifest, layout),
        validateKnowledge: (manifest) => {
          const knowledge = manifest.knowledge;
          if (
            knowledge?.scope &&
            knowledge.scopeHash &&
            knowledgeScopeHash(
              context.store.snapshot(["project", "subproject", "knowledge", "task", "settings"]),
              knowledge.scope,
            ) !== knowledge.scopeHash
          )
            throw new Error("runtime_configuration_changed");
        },
        validateSkills: (manifest, input) => skills.validate(manifest, input),
        async contributions(input, remainingTokens) {
          const selected = skills.select(input);
          const reserve = selected.reduce((total, skill) => total + skill.wrapperTokens, 0);
          if (reserve > remainingTokens) throw new Error("context_budget_hold");
          const selectedTask = input.thread.taskId
            ? context.store.record("task", input.thread.taskId)
            : undefined;
          const knowledge = knowledgeLaunch(
            context.store,
            input,
            remainingTokens - reserve - (selectedTask?.browser ? 600 : 0),
          );
          const task = input.thread.taskId
            ? context.store.record("task", input.thread.taskId)
            : undefined;
          const workspace = task?.workspaceId
            ? context.store.record("workspace", String(task.workspaceId))
            : undefined;
          return {
            skills: selected,
            ...(knowledge ? { knowledge } : {}),
            ...(typeof workspace?.baseRef === "string" ? { baseCommit: workspace.baseRef } : {}),
          };
        },
        workspace: runtimeWorkspace({ store: context.store, directory }),
        estimate: referenceTokenEstimate,
        toolTokens: referenceTokenEstimate(
          JSON.stringify([...runtimeToolDefinitions, ...indirectRuntimeToolDefinitions]),
        ),
        browserToolTokens:
          referenceTokenEstimate(JSON.stringify(browserRuntimeToolDefinitions)) -
          referenceTokenEstimate(JSON.stringify(runtimeToolDefinitions)),
        async bind(identity) {
          const token = tokens.issue(identity);
          return {
            token,
            url: mcp.url,
            setTurn: (turnId) => tokens.setTurn(identity.sessionId, turnId),
            async close() {
              tokens.revoke(identity.sessionId);
              await cua.release(identity.sessionId);
            },
          };
        },
      });
      const host: import("./session-manager.js").RuntimeHost = {
        prepare: async (input, redactor) => {
          if (input.previous && !input.previous.configuration)
            throw new Error("native_configuration_unavailable");
          const definition = await hosts.definition(input.definition);
          return native.prepare({ ...input, definition }, redactor);
        },
      };
      return { host, hosts, mcp, tokens, cua };
    })().catch((error) => {
      loaded = undefined;
      throw error;
    }));
  return {
    async prepare(input, redactor) {
      if (closed) throw new Error("runtime_closed");
      return (await load()).host.prepare(input, redactor);
    },
    async loginInfo(profileId) {
      if (closed) throw new Error("runtime_closed");
      const state = context.store.snapshot(["agent", "agentDefinition"]),
        profile = state.agent?.find((row) => row.id === profileId && !row.archived);
      if (!profile) throw new Error("profile_unavailable");
      const definition = parse(
        AgentDefinitionSchema,
        state.agentDefinition?.find((row) => row.id === profile.definitionId),
      );
      const value = await (await load()).hosts.definition(definition);
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      const keys = [
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "GEMINI_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ];
      const env = keys.flatMap((key) =>
        value.launch.env[key] ? [`${key}=${quote(value.launch.env[key] as string)}`] : [],
      );
      const args =
        value.auth?.loginCommand ??
        (value.adapter === "claude"
          ? ["auth", "login"]
          : value.adapter === "codex"
            ? ["login"]
            : undefined);
      if (!args) throw new Error("login_command_unavailable");
      return {
        provider: value.adapter,
        displayName: value.displayName,
        configDirectory:
          value.adapter === "claude"
            ? (value.launch.env.CLAUDE_CONFIG_DIR ??
              path.join(value.launch.env.HOME ?? "", ".claude"))
            : value.adapter === "codex"
              ? (value.launch.env.CODEX_HOME ?? path.join(value.launch.env.HOME ?? "", ".codex"))
              : (value.launch.env.HOME ?? ""),
        command: ["env", ...env, quote(value.launch.command), ...args.map(quote)].join(" "),
      };
    },
    async close() {
      closed = true;
      if (loaded) {
        const value = await loaded;
        value.tokens.close();
        const cleanup = await Promise.allSettled([
          value.cua.close(),
          value.hosts.close(),
          value.mcp.close(),
        ]);
        const failure = cleanup.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
    },
  };
}
