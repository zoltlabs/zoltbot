import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type AgentAdapter,
  type AgentSession,
  NativeWriters,
  type OpenOptions,
} from "@zoltbot/adapters-sdk";
import type { ArtifactBinding } from "@zoltbot/protocol";
import {
  type AgentDefinition,
  type AgentEvent,
  type Profile,
  ProfileSchema,
  parse,
  type Thread,
} from "@zoltbot/protocol";
import type { LaunchContributions, LaunchManifest } from "../../connections/src/launch-manifest.js";
import { canonicalApprovalRoot } from "./approval-paths.js";
import { type ArtifactToolSurface, frozenArtifactGuidance } from "./artifacts/binding.js";
import { cleanupStaging } from "./artifacts/staging.js";
import { type BrowserBinding, browserGuidance, materializeBrowser } from "./browser/runtime.js";
import type { connectionsRuntime } from "./connections-runtime.js";
import { forkPermission } from "./fork-configuration.js";
import type { Redactor } from "./logging.js";
import type { PreparedRuntime, RuntimeHost } from "./session-manager.js";

interface RuntimeInput {
  routineInputs?: import("@zoltbot/protocol").Routine["template"]["inputs"] | undefined;
  launchConfiguration?: unknown;
  thread: Thread;
  comparePermission?: Profile["permissionProfile"] | undefined;
  profile: Profile;
  definition: AgentDefinition;
  previous?: {
    nativeId: string;
    cwd: string;
    provider: string;
    configuration?: unknown;
    firstPromptPending?: boolean;
  };
}
export interface NativeToolBinding {
  url: string;
  token: string;
  setTurn(turnId: string | undefined): void;
  close(): Promise<void>;
}
export interface NativeRuntimeOptions {
  adapters: ReadonlyMap<string, (redactor: Redactor) => AgentAdapter>;
  workspace(input: RuntimeInput): Promise<{ cwd: string; instructions?: string }>;
  bind(identity: {
    agentId: string;
    threadId: string;
    sessionId: string;
  }): Promise<NativeToolBinding>;
  estimate(text: string): number;
  toolTokens: number;
  browserToolTokens?: number;
  artifactTools?: ArtifactToolSurface;
  prepareArtifacts?(input: RuntimeInput, cwd: string): ArtifactBinding | undefined;
  extensions?: Omit<ReturnType<typeof connectionsRuntime>, "validate" | "release"> & {
    validate?: ReturnType<typeof connectionsRuntime>["validate"];
    release?: ReturnType<typeof connectionsRuntime>["release"];
  };
  observeBrowser?(executionId: string, sessionId: string): (event: AgentEvent) => void;
  prepareBrowser?(input: RuntimeInput, cwd: string): Promise<BrowserBinding | undefined>;
  validateKnowledge?(manifest: LaunchManifest): void;
  validateSkills?(manifest: LaunchManifest, input: RuntimeInput): void;
  contributions?(input: RuntimeInput, remainingTokens: number): Promise<LaunchContributions>;
  materializeSkills?(
    manifest: LaunchManifest,
    layout?: AgentAdapter["nativeSkillLayout"],
  ): NonNullable<OpenOptions["managedSkills"]>;
}

/** Revoke tool access even if physical process cleanup fails and needs retry. */
function ownedSession(
  native: AgentSession,
  binding: NativeToolBinding,
  releaseWriter: () => void,
  observe?: (event: AgentEvent) => void,
  cleanup?: () => Promise<void>,
): AgentSession {
  let closing: Promise<void> | undefined;
  let nativeClosed = false;
  let bindingClosed = false;
  let closed = false;
  const close: AgentSession["close"] = (options) => {
    if (closed) return Promise.resolve();
    closing ??= (async () => {
      let bindingFailure: unknown;
      if (!bindingClosed) {
        try {
          await binding.close();
          bindingClosed = true;
        } catch (error) {
          bindingFailure = error;
        }
      }
      if (!nativeClosed) {
        await native.close(options);
        nativeClosed = true;
        releaseWriter();
      }
      await cleanup?.();
      if (bindingFailure !== undefined) throw bindingFailure;
      closed = true;
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  return new Proxy(native, {
    get(target, property) {
      if (property === "close") return close;
      if (property === "events" && (observe || cleanup))
        return async function* () {
          try {
            for await (const event of native.events()) {
              try {
                observe?.(event);
              } catch {}
              if (event.t === "turn.done") await cleanup?.();
              yield event;
            }
          } finally {
            await cleanup?.();
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Provider-independent assembly. Provider launch recipes remain inside their adapters. */
export class NativeRuntimeHost implements RuntimeHost {
  private readonly writers = new NativeWriters();
  private readonly adapters: NativeRuntimeOptions["adapters"];
  constructor(private readonly options: NativeRuntimeOptions) {
    this.adapters = new Map(options.adapters);
    if (!Number.isSafeInteger(options.toolTokens) || options.toolTokens < 0)
      throw new Error("invalid_token_estimate");
  }
  async prepare(input: RuntimeInput, redactor: Redactor): Promise<PreparedRuntime> {
    const stable = structuredClone({
      thread: input.thread,
      comparePermission: input.comparePermission,
      routineInputs: input.routineInputs,
      profile: input.profile,
      definition: input.definition,
      ...(input.previous ? { previous: input.previous } : {}),
      ...(input.launchConfiguration ? { launchConfiguration: input.launchConfiguration } : {}),
    });
    const saved = (stable.previous?.configuration ?? stable.launchConfiguration) as
      | {
          version?: unknown;
          profile?: unknown;
          workspaceInstructions?: unknown;
          providerHome?: unknown;
          definitionHash?: string;
          launchManifest?: LaunchManifest;
        }
      | undefined;
    const legacyResume = !!stable.previous && !saved?.launchManifest;
    const providerHome = Object.fromEntries(
      [
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "GEMINI_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].map((key) => [key, stable.definition.launch.env[key] ?? null]),
    );
    const normalizeHome = (input: unknown) => {
      if (!input || typeof input !== "object") return input;
      const value = { ...(input as Record<string, unknown>) };
      for (const key of Object.keys(providerHome)) value[key] ??= null;
      const key =
        stable.definition.adapter === "claude"
          ? "CLAUDE_CONFIG_DIR"
          : stable.definition.adapter === "codex"
            ? "CODEX_HOME"
            : undefined;
      if (key && !value[key] && typeof value.HOME === "string")
        value[key] = path.join(value.HOME, key === "CODEX_HOME" ? ".codex" : ".claude");
      return value;
    };
    const definitionForHash = {
      ...stable.definition,
      launch: {
        ...stable.definition.launch,
        env: Object.fromEntries(
          Object.entries(stable.definition.launch.env).filter(
            ([key]) => !Object.hasOwn(providerHome, key),
          ),
        ),
      },
    };
    const definitionHash = createHash("sha256")
      .update(redactor.text(JSON.stringify(definitionForHash)))
      .digest("hex");
    if (saved?.definitionHash && saved.definitionHash !== definitionHash)
      throw new Error("native_configuration_changed");
    if (saved) {
      if (
        saved.providerHome &&
        !isDeepStrictEqual(normalizeHome(saved.providerHome), normalizeHome(providerHome))
      )
        throw new Error("native_configuration_changed");
      if (saved.version !== 1 || typeof saved.workspaceInstructions !== "string")
        throw new Error("native_configuration_unavailable");
      const profile = parse(ProfileSchema, saved.profile);
      if (profile.id !== stable.profile.id || profile.definitionId !== stable.definition.id)
        throw new Error("native_configuration_changed");
      stable.profile = profile;
    }
    stable.profile.permissionProfile = forkPermission(
      stable.thread,
      stable.profile.permissionProfile,
    );
    if (stable.comparePermission) stable.profile.permissionProfile = stable.comparePermission;
    const factory = this.adapters.get(stable.definition.adapter);
    if (!factory) throw new Error("runtime_adapter_unavailable");
    const workspace = await this.options.workspace(structuredClone(stable));
    const root = canonicalApprovalRoot(workspace.cwd);
    if (!root) throw new Error("runtime_workspace_unavailable");
    if (stable.previous && stable.previous.cwd !== root.path) throw new Error("native_cwd_changed");
    const artifact =
      saved?.launchManifest?.artifact ??
      (!saved && !legacyResume ? this.options.prepareArtifacts?.(stable, root.path) : undefined);
    const hostTools = (browser: boolean) =>
      saved?.launchManifest?.hostTools ??
      this.options.artifactTools?.(!!artifact, browser, stable.thread);
    const baseTools = hostTools(false)?.filter((t) => t.name !== "team_browser_evidence");
    const instructions = [
      stable.profile.roleText,
      stable.profile.instructions,
      artifact ? frozenArtifactGuidance(artifact) : undefined,
      saved ? (saved.workspaceInstructions as string) : workspace.instructions,
    ]
      .filter((text) => typeof text === "string" && text.length)
      .join("\n\n");
    const estimated = this.options.estimate(instructions);
    if (!Number.isSafeInteger(estimated) || estimated < 0)
      throw new Error("invalid_token_estimate");
    let fixedInjectedTokens =
      estimated +
      (baseTools ? this.options.estimate(JSON.stringify(baseTools)) : this.options.toolTokens);
    const availableConnections = legacyResume
      ? []
      : (saved?.launchManifest?.connections ??
        this.options.extensions?.select(
          stable.thread.projectId,
          stable.profile.id,
          factory(redactor).manifest().supportsConnections === true,
        ) ??
        []);
    const selectedConnections =
      saved?.launchManifest || !Array.isArray(stable.routineInputs?.connections)
        ? availableConnections
        : availableConnections.filter((connection) =>
            (stable.routineInputs?.connections as string[]).includes(connection.id),
          );
    const connectionTokens = selectedConnections.reduce((n, c) => n + c.schemaTokens.value, 0);
    const contributions =
      saved?.launchManifest || legacyResume
        ? undefined
        : await this.options.contributions?.(
            structuredClone(stable),
            Math.max(0, 1500 - fixedInjectedTokens - connectionTokens),
          );
    const browser =
      saved?.launchManifest?.browser ??
      (!legacyResume && !saved?.launchManifest
        ? await this.options.prepareBrowser?.(stable, root.path)
        : undefined);
    if (browser && factory(redactor).manifest().supportsLocalBrowserCli !== true)
      throw new Error("browser_provider_unverified");
    if (browser) redactor.hideBrowserUrls();
    const browserText = browser ? browserGuidance(browser) : "";
    const browserTokens =
      this.options.estimate(browserText) +
      (browser
        ? hostTools(true) && baseTools
          ? this.options.estimate(JSON.stringify(hostTools(true))) -
            this.options.estimate(JSON.stringify(baseTools))
          : (this.options.browserToolTokens ?? 0)
        : 0);
    const selectedHostTools = hostTools(!!browser);
    const launchManifest =
      saved?.launchManifest ??
      (!legacyResume
        ? this.options.extensions?.compose(
            {
              threadId: stable.thread.id,
              profileId: stable.profile.id,
              ...(stable.thread.projectId ? { projectId: stable.thread.projectId } : {}),
              ...(stable.thread.taskId ? { taskId: stable.thread.taskId } : {}),
              cwd: root.path,
              configuration: { profile: stable.profile, providerHome, definitionHash },
              fixed: fixedInjectedTokens + browserTokens,
            },
            {
              ...contributions,
              connections: selectedConnections,
              ...(artifact ? { artifact } : {}),
              ...(selectedHostTools ? { hostTools: selectedHostTools } : {}),
              ...(browser ? { browser } : {}),
            },
          )
        : undefined);
    fixedInjectedTokens += browserTokens;
    if (launchManifest)
      fixedInjectedTokens += launchManifest.budget.connections + launchManifest.budget.skills;
    if (
      launchManifest?.skills.length &&
      (!this.options.materializeSkills ||
        factory(redactor).manifest().supportsNativeSkills !== true)
    )
      throw new Error("native_skills_loading_unavailable");
    if (fixedInjectedTokens > 1500) throw new Error("injection_fixed_budget_exceeded");
    const privateValues: string[] = [];
    if (launchManifest && this.options.extensions) {
      const resolved = await this.options.extensions.resolve(launchManifest, redactor, true);
      for (const connection of resolved)
        if (connection.kind === "https") {
          const authorization = connection.headers.Authorization;
          if (authorization?.startsWith("Bearer ")) privateValues.push(authorization.slice(7));
        }
    }
    const validateInputs = () => {
      if (!launchManifest) return;
      this.options.extensions?.validate?.(launchManifest, !saved?.launchManifest);
      if (!saved?.launchManifest) {
        this.options.validateSkills?.(launchManifest, stable);
        this.options.validateKnowledge?.(launchManifest);
      }
    };
    const checkRoot = () => {
      validateInputs();
      const current = canonicalApprovalRoot(root.path);
      if (!current || current.device !== root.device || current.inode !== root.inode)
        throw new Error("runtime_workspace_changed");
    };
    let consumed = false;
    let authority: NativeToolBinding | undefined;
    return {
      cwd: root.path,
      ...(privateValues.length ? { privateValues } : {}),
      ...(browserText && browser
        ? {
            firstTurnBrowser: {
              text: browserText,
              bindingId: browser.id,
              digest: browser.guidanceHash,
            },
          }
        : {}),
      ...(launchManifest?.knowledge ? { firstTurnKnowledge: launchManifest.knowledge } : {}),
      ...(stable.profile.model ? { model: stable.profile.model } : {}),
      ...(stable.profile.effort ? { effort: stable.profile.effort } : {}),
      configuration: {
        version: 1,
        definitionHash,
        ...(launchManifest ? { launchManifest } : {}),
        providerHome,
        profile: stable.profile,
        workspaceInstructions: saved ? saved.workspaceInstructions : (workspace.instructions ?? ""),
      },
      estimate: (text) => this.options.estimate(text),
      fixedInjectedTokens,
      validateWorkspace: checkRoot,
      validateLaunch: validateInputs,
      onTurn: (turnId) => {
        if (!authority) throw new Error("runtime_authority_unavailable");
        authority.setTurn(turnId);
      },
      open: async (request) => {
        if (consumed) throw new Error("runtime_preparation_consumed");
        consumed = true;
        checkRoot();
        if (browser) materializeBrowser(browser);
        const writerKey = (nativeId: string) =>
          JSON.stringify([
            stable.definition.adapter,
            stable.definition.flavor ?? null,
            normalizeHome(providerHome),
            nativeId,
          ]);
        let releaseWriter = request.nativeId
          ? this.writers.acquire(writerKey(request.nativeId))
          : undefined;
        let binding: NativeToolBinding;
        try {
          binding = await this.options.bind({
            agentId: stable.profile.id,
            threadId: stable.thread.id,
            sessionId: request.sessionId,
          });
        } catch (error) {
          releaseWriter?.();
          throw error;
        }
        authority = binding;
        redactor.register(binding.token);
        try {
          checkRoot();
          const connections =
            launchManifest && this.options.extensions
              ? await this.options.extensions.resolve(launchManifest, redactor)
              : [];
          const nativeSkills = launchManifest?.skills.length
            ? (this.options.materializeSkills?.(
                launchManifest,
                factory(redactor).nativeSkillLayout,
              ) ?? [])
            : [];

          const options: OpenOptions = {
            ...(launchManifest ? { launchManifestId: launchManifest.id } : {}),
            ...(nativeSkills.length ? { managedSkills: nativeSkills } : {}),
            ...(connections.length ? { connections } : {}),
            ...(launchManifest && this.options.extensions
              ? {
                  refreshConnections: () =>
                    (
                      this.options.extensions as NonNullable<NativeRuntimeOptions["extensions"]>
                    ).resolve(launchManifest, redactor),
                }
              : {}),
            identity: { agentId: stable.profile.id, threadId: stable.thread.id },
            mode: request.mode,
            ...(request.nativeId ? { nativeId: request.nativeId } : {}),
            ...(request.fork ? { fork: request.fork } : {}),
            cwd: root.path,
            permissionProfile: stable.profile.permissionProfile,
            ...(stable.profile.model ? { model: stable.profile.model } : {}),
            ...(stable.profile.effort ? { effort: stable.profile.effort } : {}),
            ...(instructions ? { appendInstructions: instructions } : {}),
            ...(stable.previous?.firstPromptPending === true ? { firstPromptPending: true } : {}),
            hostMcp: { url: binding.url, token: binding.token },
          };
          const native = await factory(redactor).open(stable.definition, options);
          // SessionManager also fences persisted configuration after asynchronous open.
          // Keep the handle available there for cleanup if the workspace changed during open.
          try {
            if (native.nativeId) releaseWriter ??= this.writers.acquire(writerKey(native.nativeId));
          } catch (error) {
            await native.close();
            throw error;
          }
          return ownedSession(
            native,
            binding,
            releaseWriter ?? (() => {}),
            browser && launchManifest
              ? this.options.observeBrowser?.(launchManifest.executionId, request.sessionId)
              : undefined,
            async () => {
              if (launchManifest) await this.options.extensions?.release?.(launchManifest);
              if (artifact) await cleanupStaging(artifact);
            },
          );
        } catch (error) {
          releaseWriter?.();
          if (launchManifest) await this.options.extensions?.release?.(launchManifest);
          await binding.close();
          throw error;
        }
      },
    };
  }
}
