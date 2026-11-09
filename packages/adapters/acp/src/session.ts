import { randomUUID } from "node:crypto";
import {
  type ClientConnection,
  type ContentBlock,
  client,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  AsyncQueue,
  materializeImages,
  nativeCommands,
  type OpenOptions,
  type SendReceipt,
} from "@zoltbot/adapters-sdk";
import type {
  AgentDefinition,
  AgentEvent,
  Capabilities,
  InteractionAnswer,
} from "@zoltbot/protocol";
import { elicitationForm, elicitationResponse } from "./elicitation.js";
import { acpError } from "./errors.js";
import type { AcpFlavor } from "./flavor.js";
import { forkAcpSession } from "./fork.js";
import { AcpMapper, permissionInteraction, permissionOutcome } from "./mapping.js";
import { AcpSettings } from "./settings.js";
import type { AcpTransport } from "./transport.js";
import { safeWire } from "./wire.js";

export class AcpSession implements AgentSession {
  nativeId: string | undefined;
  private reportedVersion = "unknown";
  private readonly pendingCommands = new Map<string, ReturnType<typeof nativeCommands>>();
  private commands(value: unknown) {
    this.capabilities.slashCommands = nativeCommands(value);
    this.capabilities.compaction.manual = this.capabilities.slashCommands.some(
      (command) => command.name === "compact",
    );
  }
  readonly capabilities: Capabilities = {
    resume: false,
    fork: false,
    steer: "queue_only",
    concurrentTurns: false,
    interrupt: "native",
    modes: [],
    models: { selectable: false },
    effort: [],
    approvals: "granular",
    questions: "none",
    planReview: "none",
    elicitation: "form",
    usage: { tokens: false, cost: false, context: false, cache: false },
    compaction: { auto: false, manual: false, events: false },
    hostTools: "none",
    images: false,
    nativeSessions: { list: false, adopt: false, visibleInOfficialApps: "unknown" },
    worktreeAware: false,
  };
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly connection: ClientConnection;
  private mapper: AcpMapper | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve: (answer: InteractionAnswer | undefined) => void;
      validate?: (answer: InteractionAnswer) => void;
    }
  >();
  private readonly waiting: ContentBlock[][] = [];
  private active: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private readonly settings = new AcpSettings();
  private prompts = 0;
  private legacyModes: string[] = [];
  private dead = false;
  private cancelled = false;
  private context: { used: number; size: number } | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly definition: AgentDefinition,
    private readonly options: OpenOptions,
    private readonly flavor: AcpFlavor,
    private readonly transport: AcpTransport,
    private readonly timeoutMs = 30000,
    private readonly reserve: (nativeId: string) => void = () => {},
    private readonly release: () => void = () => {},
    private readonly providerVersion: string | undefined = undefined,
  ) {
    this.capabilities.approvals = flavor.approvalCapability ?? "granular";
    this.capabilities.nativeSessions.visibleInOfficialApps = flavor.nativeVisibility ?? "unknown";
    this.capabilities.questions = flavor.interactionCapabilities?.questions ?? "none";
    this.capabilities.planReview = flavor.interactionCapabilities?.planReview ?? "none";
    if (flavor.interactionCapabilities?.questionFeatures)
      this.capabilities.questionFeatures = flavor.interactionCapabilities.questionFeatures;
    this.connection = client({ name: "zoltbot" })
      .onNotification("session/update", async ({ params }) => {
        if (params.update.sessionUpdate === "available_commands_update") {
          const commands = nativeCommands(params.update.availableCommands);
          if (!this.nativeId) {
            this.pendingCommands.set(params.sessionId, commands);
            if (this.pendingCommands.size > 8)
              this.pendingCommands.delete(this.pendingCommands.keys().next().value ?? "");
          } else if (params.sessionId === this.nativeId) {
            this.commands(commands);
            await this.queue.push({
              t: "capabilities.updated",
              capabilities: structuredClone(this.capabilities),
              providerVersion: this.reportedVersion,
            });
          }
          return;
        }
        if (params.sessionId !== this.nativeId || !this.mapper) return;
        this.armStallTimer();
        if (params.update.sessionUpdate === "compaction_update") {
          this.capabilities.compaction.events = true;
          this.capabilities.compaction.auto = true;
        }
        if (params.update.sessionUpdate === "config_option_update") {
          this.settings.update(params.update.configOptions);
          this.refreshSettings();
        }
        const events = [
          ...this.mapper.update(params.update),
          ...(this.flavor.mapUpdate?.(params.update) ?? []),
        ];
        this.context = this.mapper.context ?? this.context;
        if (params.update.sessionUpdate === "usage_update") {
          this.capabilities.usage.context = true;
          this.capabilities.usage.cost ||= params.update.cost?.currency === "USD";
        }
        for (const event of events) await this.queue.push(event);
      })
      .onRequest("session/request_permission", async ({ params }) => {
        if (!this.mapper || params.sessionId !== this.nativeId)
          return { outcome: { outcome: "cancelled" as const } };
        if (
          this.options.permissionProfile === "read_only" &&
          !["read", "search", "think"].includes(params.toolCall.kind ?? "other")
        ) {
          this.mapper.rejectTool(params.toolCall.toolCallId);
          const deny = params.options.find((option) => option.kind === "reject_once");
          return {
            outcome: deny
              ? { outcome: "selected" as const, optionId: deny.optionId }
              : { outcome: "cancelled" as const },
          };
        }
        clearTimeout(this.stallTimer);
        const id = randomUUID();
        const answer = new Promise<InteractionAnswer | undefined>((resolve) =>
          this.pending.set(id, { resolve }),
        );
        await this.queue.push({
          t: "interaction.requested",
          interaction: permissionInteraction(params, {
            id,
            agentId: this.options.identity.agentId,
            threadId: this.options.identity.threadId,
            turnId: this.mapper.turnId,
          }),
        });
        const resolution = await answer;
        const outcome = permissionOutcome(
          params,
          resolution?.action ?? "cancel",
          resolution?.choice,
        );
        if (
          outcome.outcome === "cancelled" ||
          (outcome.outcome === "selected" &&
            params.options.find((o) => o.optionId === outcome.optionId)?.kind.startsWith("reject_"))
        )
          this.mapper?.rejectTool(params.toolCall.toolCallId);
        return {
          outcome,
        };
      })
      .onRequest("elicitation/create", async ({ params }) => {
        if (!this.mapper || !this.nativeId) return { action: "cancel" };
        clearTimeout(this.stallTimer);
        const id = randomUUID();
        const interaction = elicitationForm(params, {
          id,
          agentId: this.options.identity.agentId,
          threadId: this.options.identity.threadId,
          turnId: this.mapper.turnId,
        });
        if (!interaction) return { action: "cancel" };
        const answer = new Promise<InteractionAnswer | undefined>((resolve) =>
          this.pending.set(id, { resolve }),
        );
        await this.queue.push({ t: "interaction.requested", interaction });
        try {
          return elicitationResponse(params, await answer);
        } catch {
          return { action: "cancel" };
        }
      })
      .onRequest("*", async ({ method, params }) => {
        const draft = this.flavor.mapExtensionRequest?.(method, params);
        if (!draft || !this.flavor.mapExtensionAnswer || !this.mapper)
          throw new RequestError(-32601, "unsupported_extension");
        const id = randomUUID();
        const answer = new Promise<InteractionAnswer | undefined>((resolve) =>
          this.pending.set(id, {
            resolve,
            validate: (answer) => {
              this.flavor.mapExtensionAnswer?.(method, params, answer);
            },
          }),
        );
        clearTimeout(this.stallTimer);
        await this.queue.push({
          t: "interaction.requested",
          interaction: {
            ...draft,
            id,
            agentId: this.options.identity.agentId,
            threadId: this.options.identity.threadId,
            turnId: this.mapper.turnId,
            nativeRef: id,
          },
        });
        return this.flavor.mapExtensionAnswer(method, params, await answer);
      })
      .onNotification("*", async ({ method, params }) => {
        try {
          for (const event of this.flavor.mapExtensionNotification?.(method, params) ?? []) {
            if ("turnId" in event) {
              if (this.mapper) await this.queue.push({ ...event, turnId: this.mapper.turnId });
            } else await this.queue.push(event);
          }
        } catch {
          await this.queue.push({
            t: "status",
            state: "error",
            detail: "extension_notification_error",
          });
        }
      })
      .connect(
        safeWire(transport, (code) => {
          void this.queue.push({ t: "status", state: "error", detail: code });
        }),
      );
    void transport.closed.then(() => this.died());
    void this.connection.closed.then(() => this.died());
  }
  private async request<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("request_timeout")), this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async initialize() {
    try {
      const init = await this.request(
        this.connection.agent.request<InitializeResponse>("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            elicitation: { form: {} },
            session: { compaction: {}, notices: {} },
          },
          clientInfo: this.flavor.clientInfo ?? { name: "zoltbot", version: "0.1.0" },
          ...(this.flavor.extraInitMeta ? { _meta: this.flavor.extraInitMeta } : {}),
        }),
      );
      if (init.protocolVersion !== 1) throw new Error("unsupported_acp_version");
      this.reportedVersion = init.agentInfo?.version ?? this.providerVersion ?? "unknown";
      this.capabilities.resume = init.agentCapabilities?.loadSession ?? false;
      const advertisedFork = !!(
        init.agentCapabilities?.sessionCapabilities as { fork?: unknown } | undefined
      )?.fork;
      const forkPolicy = this.flavor.nativeFork;
      const verifiedFork =
        !!forkPolicy?.versions.includes(this.reportedVersion) &&
        (forkPolicy.route !== "standard" || advertisedFork);
      this.capabilities.fork = verifiedFork;
      this.capabilities.nativeFork = {
        latest: verifiedFork,
        boundaries: [],
        callerId: forkPolicy?.route === "grok",
        activation: forkPolicy?.route === "grok" ? "load" : "active",
        ...(verifiedFork ? {} : { reason: "native_fork_unverified" }),
      };
      this.capabilities.nativeSessions.adopt = this.capabilities.resume;
      this.capabilities.images = init.agentCapabilities?.promptCapabilities?.image ?? false;
      const auth = this.flavor.chooseAuth?.(init.authMethods ?? [], {
        ...this.definition.launch.env,
        ...this.options.env,
      });
      if (auth)
        await this.request(
          this.connection.agent.request("authenticate", {
            methodId: auth.methodId,
            ...(auth.meta ? { _meta: auth.meta } : {}),
          }),
        );
      if (this.flavor.mcpInjection !== "session_new")
        throw new Error("config_file_mcp_requires_flavor_host");
      if (!init.agentCapabilities?.mcpCapabilities?.http) throw new Error("http_mcp_not_supported");
      this.capabilities.hostTools = "mcp_http";
      const params = {
        cwd: this.options.cwd,
        mcpServers: [
          {
            type: "http" as const,
            name: "zoltbot",
            url: this.options.hostMcp.url,
            headers: [{ name: "Authorization", value: `Bearer ${this.options.hostMcp.token}` }],
          },
        ],
      };
      if (this.options.mode === "fork") {
        const session = await forkAcpSession(
          this.flavor,
          this.reportedVersion,
          advertisedFork,
          this.options,
          params,
          (method, input) =>
            this.request(this.connection.agent.request<Record<string, unknown>>(method, input)),
        );
        this.nativeId = session.sessionId as string;
        this.settings.update((session as unknown as NewSessionResponse).configOptions ?? []);
        this.legacyModes =
          (session as unknown as NewSessionResponse).modes?.availableModes.map((m) => m.id) ?? [];
      } else if (this.options.mode === "resume") {
        if (!this.capabilities.resume || !this.options.nativeId)
          throw new Error("unsupported_resume");
        const session = await this.request(
          this.connection.agent.request<LoadSessionResponse>("session/load", {
            ...params,
            sessionId: this.options.nativeId,
          }),
        );
        this.nativeId = this.options.nativeId;
        this.legacyModes = session.modes?.availableModes.map((m) => m.id) ?? [];
        this.settings.update(session.configOptions ?? []);
      } else {
        const session = await this.request(
          this.connection.agent.request<NewSessionResponse>("session/new", params),
        );
        this.nativeId = session.sessionId;
        this.settings.update(session.configOptions ?? []);
        this.legacyModes = session.modes?.availableModes.map((m) => m.id) ?? [];
      }
      if (!this.nativeId) throw new Error("provider_protocol_error");
      this.reserve(this.nativeId);
      const commands = this.pendingCommands.get(this.nativeId);
      if (commands) this.commands(commands);
      this.pendingCommands.clear();
      this.refreshSettings();
      if (this.options.permissionProfile === "read_only" && this.flavor.readOnlyModes) {
        const mode = this.flavor.readOnlyModes.find((mode) =>
          this.capabilities.modes.includes(mode),
        );
        if (!mode) throw new Error("read_only_mode_unavailable");
        await this.setMode(mode);
      }
      if (this.options.model) await this.setModel(this.options.model, this.options.effort);
      await this.queue.push({
        t: "session.ready",
        nativeId: this.nativeId ?? "",
        capabilities: structuredClone(this.capabilities),
        providerVersion: this.reportedVersion,
      });
      return this;
    } catch (error) {
      await this.close();
      throw acpError(error);
    }
  }
  events() {
    return this.queue;
  }
  async send(
    input: Parameters<AgentSession["send"]>[0],
    _mode: "queue" | "steer",
  ): Promise<SendReceipt> {
    if (this.closed || this.dead || !this.nativeId) throw new Error("session_closed");
    input = await materializeImages(input);
    const blocks: ContentBlock[] = input.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "file") return { type: "text", text: `@${block.path}` };
      if (block.type === "image" && block.base64 && block.mimeType && this.capabilities.images)
        return { type: "image", data: block.base64, mimeType: block.mimeType };
      throw new Error("unsupported_input_block");
    });
    const inject =
      this.flavor.instructionInjection === "first_block"
        ? this.prompts === 0
        : this.flavor.instructionInjection === "refresh_every_n_prompts" &&
          this.prompts % (this.flavor.refreshEvery ?? 1) === 0;
    if (
      inject &&
      (this.options.mode === "new" ||
        (this.options.mode === "resume" && this.options.firstPromptPending === true)) &&
      this.options.appendInstructions
    )
      blocks.unshift({ type: "text", text: this.options.appendInstructions });
    this.prompts++;
    if (this.active) {
      this.waiting.push(blocks);
      await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
      return { disposition: "queued" };
    }
    this.start(blocks);
    return { disposition: "started" };
  }
  private start(blocks: ContentBlock[]) {
    this.cancelled = false;
    const mapper = new AcpMapper(
      randomUUID(),
      blocks.some((b) => b.type === "text" && /^\/compact(?:\s|$)/.test(b.text))
        ? "manual"
        : "auto",
    );
    this.mapper = mapper;
    this.active = (async () => {
      await this.queue.push({ t: "turn.started", turnId: mapper.turnId });
      let reason = "error";
      this.armStallTimer();
      try {
        const response = await this.connection.agent.request<PromptResponse>("session/prompt", {
          sessionId: this.nativeId ?? "",
          prompt: blocks,
        });
        reason = response.stopReason;
      } catch (error) {
        if (!this.closed)
          await this.queue.push({
            t: "status",
            state: acpError(error).message === "auth_required" ? "auth_required" : "error",
            detail: "provider_request_failed",
          });
      }
      clearTimeout(this.timeout);
      clearTimeout(this.stallTimer);
      await this.clearPending("turn_ended");
      for (const event of mapper.finish(this.cancelled ? "cancelled" : reason))
        await this.queue.push(event);
      this.mapper = undefined;
      this.active = undefined;
      const next = this.waiting.shift();
      if (next && !this.closed && !this.dead) {
        await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
        this.start(next);
      }
    })();
  }
  async interrupt() {
    this.waiting.length = 0;
    await this.queue.push({ t: "queue.updated", pending: 0 });
    if (!this.active || !this.nativeId || this.cancelled) return;
    this.cancelled = true;
    await this.connection.agent.notify("session/cancel", { sessionId: this.nativeId });
    await this.clearPending("turn_ended");
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      void this.close();
    }, 3000);
    if (this.flavor.cancelBehavior === "cancel_then_resume") {
      await this.active;
      if (this.closed || this.dead || !this.capabilities.resume)
        throw new Error("cancel_resume_failed");
      await this.request(
        this.connection.agent.request("session/load", {
          sessionId: this.nativeId,
          cwd: this.options.cwd,
          mcpServers: [
            {
              type: "http",
              name: "zoltbot",
              url: this.options.hostMcp.url,
              headers: [{ name: "Authorization", value: `Bearer ${this.options.hostMcp.token}` }],
            },
          ],
        }),
      );
    }
  }
  async respond(id: string, answer: InteractionAnswer) {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("interaction_not_pending");
    pending.validate?.(answer);
    this.pending.delete(id);
    pending.resolve(answer);
    this.armStallTimer();
    await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason: "provider_resolved" });
  }
  private armStallTimer() {
    clearTimeout(this.stallTimer);
    if (this.closed || this.pending.size || this.flavor.promptStaysOpenForBackground) return;
    this.stallTimer = setTimeout(() => {
      void (async () => {
        await this.queue.push({ t: "status", state: "error", detail: "request_timeout" });
        this.connection.close();
        await this.transport.close();
      })();
    }, this.timeoutMs);
  }
  private async clearPending(reason: "turn_ended" | "process_died") {
    for (const [id, pending] of this.pending) {
      pending.resolve(undefined);
      await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason });
    }
    this.pending.clear();
  }
  private async died() {
    if (this.closed || this.dead) return;
    this.dead = true;
    clearTimeout(this.stallTimer);
    await this.clearPending("process_died");
    this.waiting.length = 0;
    await this.queue.push({ t: "status", state: "error", detail: "process_died" });
    this.connection.close();
    await this.transport.close();
    this.release();
  }
  async setMode(mode: string) {
    if (!this.nativeId || !this.capabilities.modes.includes(mode))
      throw new Error("unsupported_mode");
    if (
      this.options.permissionProfile === "read_only" &&
      !(this.flavor.readOnlyModes ?? ["ask", "plan", "read_only", "read-only"]).includes(mode)
    )
      throw new Error("permission_profile_ceiling");
    const selection = this.settings.modeSelection(mode);
    if (selection) {
      const response = await this.request(
        this.connection.agent.request<SetSessionConfigOptionResponse>("session/set_config_option", {
          sessionId: this.nativeId,
          ...selection,
        }),
      );
      this.settings.update(response.configOptions);
      if (this.settings.currentMode !== mode) throw new Error("mode_change_not_confirmed");
      this.refreshSettings();
    } else
      await this.request(
        this.connection.agent.request("session/set_mode", {
          sessionId: this.nativeId,
          modeId: mode,
        }),
      );
  }
  private refreshSettings() {
    this.capabilities.modes = this.settings.hasModes ? this.settings.modes : this.legacyModes;
    this.capabilities.models = {
      selectable: this.settings.models.length > 0,
      list: this.settings.models,
    };
    this.capabilities.effort = this.settings.effort;
  }
  async setModel(model: string, effort?: string) {
    if (!this.nativeId || this.closed) throw new Error("session_closed");
    const selections = this.settings.selection(model, effort);
    for (const selection of selections) {
      const response = await this.request(
        this.connection.agent.request<SetSessionConfigOptionResponse>("session/set_config_option", {
          sessionId: this.nativeId,
          ...selection,
        }),
      );
      this.settings.update(response.configOptions);
    }
    this.refreshSettings();
  }
  async compact(instructions?: string) {
    if (!this.capabilities.compaction.manual) throw new Error("unsupported_manual_compaction");
    await this.send(
      [{ type: "text", text: `/compact${instructions ? ` ${instructions}` : ""}` }],
      "queue",
    );
  }
  async rename(_name: string) {
    throw new Error("unsupported_rename");
  }
  async contextUsage() {
    return this.context;
  }
  close() {
    this.closePromise ??= this.finishClose();
    return this.closePromise;
  }
  private async finishClose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timeout);
    clearTimeout(this.stallTimer);
    this.waiting.length = 0;
    await this.clearPending("turn_ended");
    this.connection.close();
    await this.transport.close();
    await this.active;
    this.release();
    this.queue.close();
  }
}
