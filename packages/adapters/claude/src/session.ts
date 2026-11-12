import { randomUUID } from "node:crypto";
import {
  type EffortLevel,
  type ElicitationRequest,
  type ElicitationResult,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentSession,
  AsyncQueue,
  hostMcpTokenEnvironment,
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
  UserInput,
} from "@zoltbot/protocol";
import { ClaudeBackground } from "./background.js";
import { declined } from "./elicitation.js";
import type { ClaudeHost } from "./host.js";
import { type ClaudePolicy, claudeAnswer, claudeInteraction, grantedMode } from "./interactions.js";
import { claudeMode, claudeModes, claudeOptions, claudeSafeModes } from "./launch.js";
import { ClaudeMapper } from "./mapping.js";
import { rewindResult } from "./rewind.js";
import { claudeCapabilities, claudeModelOptions } from "./session-capabilities.js";
import { HostProcess } from "./transport.js";
import { rateLimitStatus, record, string } from "./usage.js";

// Up to five seconds for Zoltbot's tool server to finish connecting.
const hostToolAttempts = 50,
  hostToolDelayMs = 100;
const maxFrameBytes = 1048576;
// How long a steer waits for running subagents to move to the background, as in T3 Code.
const steerBackgroundMs = 5000;
type Pending = {
  request: Record<string, unknown>;
  plan?: string;
  resolve(response: Record<string, unknown>): void;
};
/** The answer for a request that is no longer pending: deny the tool or cancel the form. */
const ended = (request: Record<string, unknown>) =>
  request.subtype === "elicitation"
    ? { action: "cancel" }
    : { behavior: "deny", message: "Request ended." };

export class ClaudeSession implements AgentSession {
  readonly capabilities: Capabilities = claudeCapabilities();
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly pending = new Map<string, Pending>();
  private readonly background = new ClaudeBackground();
  /** Zoltbot turn id to the native user message uuid that file checkpoints are keyed by. */
  private readonly checkpoints = new Map<string, string>();
  private readonly waiting: UserInput[] = [];
  private query: Query | undefined;
  private prompts: AsyncQueue<SDKUserMessage> | undefined;
  private process: HostProcess | undefined;
  private reading: Promise<void> | undefined;
  private config: { path: string; dispose(): Promise<void> } | undefined;
  private chain = Promise.resolve();
  private connecting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private mapper: ClaudeMapper | undefined;
  private closed = false;
  private dead = false;
  private busy = false;
  private rewinding = false;
  private hadInput = false;
  /** Whether the running turn takes steered input; a manual compaction does not. */
  private steerable = false;
  private mode: string;
  private providerVersion = "unknown";
  private announced = false;
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly host: ClaudeHost,
    private readonly definition: AgentDefinition,
    private readonly options: OpenOptions,
    readonly nativeId: string,
    private readonly releaseWriter: () => void,
    private readonly timeoutMs = 30000,
    private readonly idleMs = 600000,
  ) {
    this.mode = claudeMode(options);
    this.capabilities.modes = claudeModes(options);
    this.capabilities.safeModes = claudeSafeModes(options);
  }
  private get policy(): ClaudePolicy {
    return {
      modes: this.capabilities.modes,
      baseMode: claudeMode(this.options),
      cwd: this.options.cwd,
    };
  }
  events() {
    return this.queue;
  }
  async ready() {
    await this.ensureQuery();
    await this.queue.push({
      t: "session.ready",
      nativeId: this.nativeId,
      capabilities: structuredClone(this.capabilities),
      providerVersion: this.providerVersion,
    });
    await this.queue.push({ t: "mode.changed", mode: this.mode });
    this.announced = true;
    this.armIdle();
  }
  private async changeMode(mode: string) {
    if (mode === this.mode) return;
    this.mode = mode;
    await this.queue.push({ t: "mode.changed", mode });
  }
  private ensureQuery(): Promise<void> {
    if (this.closed || this.dead) return Promise.reject(new Error("session_closed"));
    if (this.connecting) return this.connecting.then(() => this.ensureQuery());
    if (this.stopping) return this.stopping.then(() => this.ensureQuery());
    if (this.query) return Promise.resolve();
    const operation = this.connect();
    this.connecting = operation;
    return operation.finally(() => {
      if (this.connecting === operation) this.connecting = undefined;
    });
  }
  private async connect() {
    const tokenEnv = hostMcpTokenEnvironment(this.options);
    const connections =
      (await this.options.refreshConnections?.()) ?? this.options.connections ?? [];
    this.config = await this.host.config(
      {
        mcpServers: {
          ...Object.fromEntries(
            connections.map((connection) => [
              connection.name,
              connection.kind === "https"
                ? { type: "http", url: connection.url, headers: connection.headers }
                : { command: connection.command, args: connection.args },
            ]),
          ),
          zoltbot: {
            type: "http",
            url: this.options.hostMcp.url,
            headers: {
              Authorization: `Bearer ${tokenEnv ? `\${${tokenEnv}}` : this.options.hostMcp.token}`,
            },
          },
        },
      },
      this.options.launchManifestId,
    );
    try {
      const options: OpenOptions = this.hadInput
        ? { ...this.options, mode: "resume", nativeId: this.nativeId }
        : this.options;
      const settings = claudeOptions(
        this.definition,
        options,
        this.config.path,
        this.nativeId,
        this.mode,
      );
      const input = new AsyncQueue<SDKUserMessage>();
      const { command, args } = this.definition.launch;
      let spawned: HostProcess | undefined;
      const query = sdkQuery({
        prompt: input,
        options: {
          ...settings,
          canUseTool: (tool, toolInput, context) =>
            this.permission(query, tool, toolInput, context),
          onElicitation: (request, context) => this.elicitation(query, request, context.signal),
          spawnClaudeCodeProcess: (spawn) => {
            spawned = new HostProcess(
              (launch) => this.host.connect(this.definition, options, launch),
              { command, cwd: options.cwd },
              args,
              spawn,
            );
            return spawned;
          },
        },
      });
      this.query = query;
      this.prompts = input;
      this.reading = this.read(query);
      let initialized: Record<string, unknown>;
      try {
        initialized = record(await this.control((q) => q.initializationResult(), true));
      } catch (error) {
        throw spawned?.failure ?? error;
      }
      this.process = spawned;

      this.providerVersion = string(initialized.claude_code_version);
      if (this.providerVersion === "2.1.319")
        this.capabilities.nativeFork = {
          latest: true,
          boundaries: [],
          callerId: true,
          activation: "active",
        };
      // initialize materializes the native fork; a later reconnect resumes this child.
      if (options.mode === "fork") this.hadInput = true;
      if (Array.isArray(initialized.models)) {
        const options = claudeModelOptions(initialized.models);
        this.capabilities.models.list = options.list;
        this.capabilities.effort = options.effort;
      }
      if (Array.isArray(initialized.commands))
        this.capabilities.slashCommands = nativeCommands(initialized.commands);
      else delete this.capabilities.slashCommands;
      for (const skill of this.options.managedSkills ?? [])
        if (
          !this.capabilities.slashCommands?.some(
            (command) => command.name === `${skill.namespace}:${skill.name}`,
          )
        )
          throw new Error("native_skill_not_reported_loaded");
      if (initialized.current_permission_mode !== this.mode)
        throw new Error("permission_mode_mismatch");
      // Newer Claude versions connect HTTP servers in the background, so "pending" is
      // expected right after initialize. Wait a bounded time for it to connect.
      for (let attempt = 0; ; attempt++) {
        const status = await this.control((q) => q.mcpServerStatus());
        const host = status.find((server) => server.name === "zoltbot");
        if (host?.status === "connected") break;
        if (host?.status !== "pending" || attempt >= hostToolAttempts || this.closed || this.dead)
          throw new Error("host_tools_unavailable");
        await new Promise((resolve) => setTimeout(resolve, hostToolDelayMs));
      }
      if (this.closed || this.dead) throw new Error("session_closed");
      if (this.announced)
        await this.queue.push({
          t: "capabilities.updated",
          capabilities: structuredClone(this.capabilities),
          providerVersion: this.providerVersion,
        });
    } catch (error) {
      await this.stopQuery();
      throw error;
    }
  }
  private stopQuery(): Promise<void> {
    if (this.stopping) return this.stopping;
    const operation = this.stop();
    this.stopping = operation.finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  private async stop() {
    const query = this.query,
      process = this.process,
      reading = this.reading;
    this.query = undefined;
    this.process = undefined;
    this.reading = undefined;
    this.prompts?.close();
    this.prompts = undefined;
    const config = this.config;
    this.config = undefined;
    try {
      query?.close();
      await reading;
      await process?.exited;
    } finally {
      await config?.dispose();
    }
    // Background tasks live in the native process and end with it.
    if (!this.closed) for (const event of this.background.ended()) await this.queue.push(event);
  }
  private input(input: UserInput) {
    return input.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "file") return { type: "text", text: `@${part.path}` };
      if (part.base64 && part.mimeType)
        return {
          type: "image",
          source: { type: "base64", media_type: part.mimeType, data: part.base64 },
        };
      throw new Error("unsupported_input_block");
    });
  }
  async send(input: UserInput, mode: "queue" | "steer"): Promise<SendReceipt> {
    if (this.closed || this.dead) throw new Error("session_closed");
    input = await materializeImages(input);
    this.input(input);
    if (mode === "steer" && this.busy && this.steerable && !this.rewinding) {
      const receipt = await this.steer(input);
      if (receipt) return receipt;
    }
    if (this.busy || this.rewinding) {
      this.waiting.push(input);
      await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
      return { disposition: "queued" };
    }
    return this.begin(input);
  }
  /**
   * Sends input into the running turn with priority "now", as T3 Code does. Claude ends the
   * current segment and carries on with it in the same turn. That also cancels foreground tool
   * calls, so running subagents move to the background first, for at most five seconds.
   * Returns undefined when the turn ended meanwhile; the input then queues for the next turn.
   */
  private async steer(input: UserInput): Promise<SendReceipt | undefined> {
    const mapper = this.mapper,
      query = this.query;
    if (!mapper || !query) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(mapper.runningAgents().map((id) => query.backgroundTasks(id))),
      new Promise((resolve) => {
        timer = setTimeout(resolve, steerBackgroundMs);
      }),
    ]);
    clearTimeout(timer);
    if (this.mapper !== mapper || this.query !== query || !this.busy || !this.prompts)
      return undefined;
    mapper.steer();
    await this.prompts.push(this.message(this.input(input), randomUUID(), "now"));
    this.armTurn();
    return { disposition: "started", id: mapper.turnId };
  }
  private message(content: unknown, uuid: string, priority?: "now"): SDKUserMessage {
    const message = {
      type: "user",
      uuid,
      session_id: this.nativeId,
      parent_tool_use_id: null,
      message: { role: "user", content },
      ...(priority ? { priority } : {}),
    } as SDKUserMessage;
    if (Buffer.byteLength(JSON.stringify(message)) > maxFrameBytes)
      throw new Error("frame_too_large");
    return message;
  }
  private begin(input: UserInput): Promise<SendReceipt> {
    return this.start(this.input(input), false);
  }
  /** Starts one native turn. A manual compaction is a turn whose input is the /compact command. */
  private async start(content: unknown, compaction: boolean): Promise<SendReceipt> {
    this.busy = true;
    clearTimeout(this.idleTimer);
    try {
      await this.ensureQuery();
      if (this.closed || this.dead) throw new Error("session_closed");
      const turnId = randomUUID(),
        uuid = randomUUID();
      this.mapper = new ClaudeMapper(turnId, this.background);
      await this.queue.push({ t: "turn.started", turnId });
      if (compaction)
        await this.queue.push({ t: "compaction", state: "started", trigger: "manual" });
      else {
        this.hadInput = true;
        this.remember(turnId, uuid);
      }
      // Claude uses a supplied uuid as the prompt uuid, and file checkpoints are keyed by it.
      const message = this.message(content, uuid);
      if (!this.prompts) throw new Error("session_closed");
      this.steerable = !compaction;
      await this.prompts.push(message);
      this.armTurn();
      return { disposition: "started", id: turnId };
    } catch (error) {
      await this.fail("turn_start_failed");
      throw error;
    }
  }
  private remember(turnId: string, uuid: string) {
    this.checkpoints.delete(turnId);
    this.checkpoints.set(turnId, uuid);
    for (const key of this.checkpoints.keys()) {
      if (this.checkpoints.size <= 500) break;
      this.checkpoints.delete(key);
    }
  }
  /** Frames that belong to the session rather than a turn; they can arrive between turns. */
  private async session(frame: Record<string, unknown>) {
    if (frame.type === "rate_limit_event") {
      const status = rateLimitStatus(frame);
      if (status) await this.queue.push(status);
      return true;
    }
    if (frame.type !== "system") return false;
    if (frame.subtype === "init") {
      if (frame.session_id !== this.nativeId) throw new Error("native_session_mismatch");
      if (typeof frame.permissionMode === "string" && frame.permissionMode)
        await this.changeMode(frame.permissionMode);
      return true;
    }
    if (frame.subtype === "status") {
      if (typeof frame.permissionMode === "string" && frame.permissionMode)
        await this.changeMode(frame.permissionMode);
      return true;
    }
    if (["task_started", "task_progress", "task_notification"].includes(String(frame.subtype))) {
      for (const event of this.background.system(frame)) await this.queue.push(event);
      if (this.mapper) this.armTurn();
      return true;
    }
    return false;
  }
  private async receive(frame: Record<string, unknown>) {
    if (this.closed || this.dead) return;
    if (await this.session(frame)) return;
    const mapper = this.mapper;
    if (!mapper) return;
    this.armTurn();
    for (const event of mapper.frame(frame)) {
      await this.queue.push(event);
      if (event.t === "turn.done") {
        clearTimeout(this.turnTimer);
        // Prefer the uuid Claude replayed; compaction turns have no checkpoint.
        if (mapper.userUuid && this.checkpoints.has(mapper.turnId))
          this.remember(mapper.turnId, mapper.userUuid);
        this.busy = false;
        this.mapper = undefined;
        await this.clearPending("turn_ended");
        const next = this.waiting.shift();
        if (next) {
          await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
          void this.begin(next).catch(() => {});
        } else this.armIdle();
      }
    }
  }
  /** Reads SDK messages in order. The stream ends when the process does or the query closes. */
  private async read(query: Query) {
    let code = "process_died";
    try {
      for await (const message of query) {
        const frame = message as unknown as Record<string, unknown>;
        this.chain = this.chain
          .then(() => this.receive(frame))
          .catch(() => this.fail("provider_protocol_error"));
      }
    } catch {
      if (this.process?.exitCode === null) code = "provider_protocol_error";
    }
    // Queued, not awaited: a frame that fails the session stops this query and waits for the read.
    this.chain = this.chain.then(() =>
      this.query === query && !this.closed ? this.fail(code) : undefined,
    );
  }
  private permission(
    query: Query,
    tool: string,
    input: Record<string, unknown>,
    context: {
      signal: AbortSignal;
      suggestions?: unknown[];
      toolUseID: string;
      blockedPath?: string;
    },
  ) {
    return this.ask(
      query,
      {
        subtype: "can_use_tool",
        tool_name: tool,
        input,
        tool_use_id: context.toolUseID,
        ...(context.suggestions ? { permission_suggestions: context.suggestions } : {}),
        ...(context.blockedPath ? { blocked_path: context.blockedPath } : {}),
      },
      context.signal,
    ) as Promise<PermissionResult>;
  }
  /** Elicitations always get an answer; anything Zoltbot cannot show is declined (fail closed). */
  private async elicitation(query: Query, request: ElicitationRequest, signal: AbortSignal) {
    try {
      return (await this.ask(
        query,
        {
          subtype: "elicitation",
          mcp_server_name: request.serverName,
          message: request.message,
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.url ? { url: request.url } : {}),
          ...(request.requestedSchema ? { requested_schema: request.requestedSchema } : {}),
        },
        signal,
      )) as unknown as ElicitationResult;
    } catch {
      return declined as ElicitationResult;
    }
  }
  /**
   * Turns a native request into an interaction and waits for its answer. The SDK calls back as
   * soon as it reads the request, so messages read just before it are mapped first; plan text
   * and tool state then match what the stream-json order gave.
   */
  private async ask(query: Query, request: Record<string, unknown>, signal: AbortSignal) {
    await new Promise((resolve) => setImmediate(resolve));
    await this.chain;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.chain = this.chain.then(async () => {
        if (!this.mapper || this.closed || this.dead || this.query !== query || signal.aborted)
          return reject(new Error("unsupported_control_request"));
        const id = randomUUID();
        let interaction: ReturnType<typeof claudeInteraction>, plan: string | undefined;
        try {
          plan =
            typeof request.tool_use_id === "string"
              ? this.mapper.planText(request.tool_use_id)
              : undefined;
          interaction = claudeInteraction(
            request,
            { id, ...this.options.identity, turnId: this.mapper.turnId },
            plan,
            this.policy,
          );
        } catch {
          return reject(new Error("unsupported_control_request"));
        }
        clearTimeout(this.turnTimer);
        this.pending.set(id, { request, resolve, ...(plan ? { plan } : {}) });
        // Claude withdraws a request when its turn is interrupted or the tool call is cancelled.
        signal.addEventListener(
          "abort",
          () => {
            // The SDK also aborts when the process ends; fail and close clear those requests.
            if (this.process?.exitCode !== null || !this.pending.delete(id)) return;
            resolve(ended(request));
            void this.queue.push({
              t: "interaction.cleared",
              nativeRef: id,
              reason: "provider_resolved",
            });
          },
          { once: true },
        );
        await this.queue.push({ t: "interaction.requested", interaction });
      });
    });
  }
  async respond(id: string, answer: InteractionAnswer) {
    const pending = this.pending.get(id);
    if (!pending || this.closed || this.dead) throw new Error("interaction_not_pending");
    const result = claudeAnswer(pending.request, answer, this.policy, pending.plan);
    this.pending.delete(id);
    if (result.behavior === "deny" && typeof pending.request.tool_use_id === "string")
      this.mapper?.denyTool(pending.request.tool_use_id);
    pending.resolve(result);
    await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason: "provider_resolved" });
    const mode = result.behavior === "allow" ? grantedMode(result) : undefined;
    if (mode) await this.confirmMode(mode);
    this.armTurn();
  }
  /**
   * A setMode update inside a permission answer is not acknowledged by Claude. Apply it again
   * through set_permission_mode, whose success is the confirmation; only then report it.
   */
  private async confirmMode(mode: string) {
    try {
      await this.control((q) => q.setPermissionMode(mode as never));
    } catch {
      return;
    }
    if (!this.closed && !this.dead) await this.changeMode(mode);
  }
  private async clearPending(reason: "turn_ended" | "process_died") {
    const entries = [...this.pending];
    this.pending.clear();
    for (const [id, pending] of entries) {
      pending.resolve(ended(pending.request));
      await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason });
    }
  }
  async interrupt() {
    this.waiting.length = 0;
    await this.queue.push({ t: "queue.updated", pending: 0 });
    if (!this.busy || this.closed || this.dead) return;
    await this.connecting;
    this.mapper?.interrupt();
    await this.control((q) => q.interrupt());
  }
  /**
   * Applies a model and effort to the running process, as T3 Code does; the next launch also
   * uses them. Only when Claude refuses the live change does the process relaunch.
   */
  async setModel(model: string, effort?: string) {
    if (!model || this.closed || this.dead) throw new Error("unsupported_model");
    await this.connecting;
    if (this.query) {
      try {
        await this.control((q) => q.setModel(model));
        // null returns effort to the model's default, like a launch without --effort.
        await this.control((q) =>
          q.applyFlagSettings({ effortLevel: (effort ?? null) as EffortLevel | null }),
        );
        this.keepModel(model, effort);
        return;
      } catch {
        // Relaunch below.
      }
    }
    this.idleForRelaunch();
    this.keepModel(model, effort);
    await this.stopQuery();
    this.armIdle();
  }
  private keepModel(model: string, effort?: string) {
    this.options.model = model;
    if (effort) this.options.effort = effort;
    else delete this.options.effort;
  }
  /** Relaunching for a rename or refused model change would kill running background tasks. */
  private idleForRelaunch() {
    if (this.busy || this.rewinding || this.background.running().length)
      throw new Error("session_busy");
  }
  async setMode(mode: string) {
    if (!this.capabilities.modes.includes(mode)) throw new Error("unsupported_mode");
    await this.ensureQuery();
    await this.control((q) => q.setPermissionMode(mode as never));
    await this.changeMode(mode);
  }
  /** Sends /compact as a stream-json user message. Resolves once Claude has the command. */
  async compact(instructions?: string) {
    if (this.closed || this.dead) throw new Error("session_closed");
    if (this.busy || this.rewinding) throw new Error("session_busy");
    const command = instructions?.trim() ? `/compact ${instructions.trim()}` : "/compact";
    await this.start([{ type: "text", text: command }], true);
  }
  async stopBackground(taskId: string) {
    if (this.closed || this.dead) throw new Error("session_closed");
    if (this.background.get(taskId)?.state !== "running")
      throw new Error("background_task_not_running");
    // A closed process already took its tasks with it, so this never relaunches one.
    if (!this.query) throw new Error("background_task_not_running");
    await this.control((q) => q.stopTask(taskId));
    for (const event of this.background.stopped(taskId)) await this.queue.push(event);
  }
  async rewindFiles(turnId: string, dryRun: boolean) {
    if (this.closed || this.dead) throw new Error("session_closed");
    const uuid = this.checkpoints.get(turnId);
    if (!uuid) throw new Error("unsupported_rewind");
    if (this.busy || this.rewinding) throw new Error("session_busy");
    // Input sent while files are restored waits until the rewind ends (see send).
    this.rewinding = true;
    clearTimeout(this.idleTimer);
    try {
      return await this.rewind(uuid, dryRun);
    } finally {
      this.rewinding = false;
      const next = this.busy || this.closed || this.dead ? undefined : this.waiting.shift();
      if (next) {
        await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
        void this.begin(next).catch(() => {});
      } else this.armIdle();
    }
  }
  private async rewind(uuid: string, dryRun: boolean) {
    await this.ensureQuery();
    const request = (dry: boolean) =>
      this.control((q) => q.rewindFiles(uuid, { dryRun: dry })) as Promise<Record<string, unknown>>;
    // A dry run reports the affected files; the real rewind response carries only canRewind.
    const preview = rewindResult(await request(true));
    if (dryRun || !preview.canRewind) return preview;
    try {
      const applied = rewindResult(await request(false));
      return applied.canRewind ? { ...preview, ...applied, files: preview.files } : applied;
    } catch (error) {
      // Claude answers a failed rewind with a control error whose text is not forwarded.
      if (error instanceof Error && error.message === "provider_control_error")
        return { canRewind: false, files: [], error: "rewind_failed" };
      throw error;
    }
  }
  async rename(name: string) {
    if (!name || this.closed || this.dead) throw new Error("invalid_name");
    this.idleForRelaunch();
    this.options.name = name;
    await this.stopQuery();
    this.armIdle();
  }
  async contextUsage() {
    await this.ensureQuery();
    const result = (await this.control((q) => q.getContextUsage({ detail: "summary" }))) as
      | Record<string, unknown>
      | undefined;
    if (
      !result ||
      !Number.isSafeInteger(result.totalTokens) ||
      !Number.isSafeInteger(result.maxTokens) ||
      Number(result.totalTokens) < 0 ||
      Number(result.maxTokens) < 1
    )
      throw new Error("provider_protocol_error");
    return { used: Number(result.totalTokens), size: Number(result.maxTokens) };
  }
  /**
   * Sends one control request with the session timeout. When an ordinary request times out, a
   * context usage probe decides whether the process is stuck; a probe timeout fails the session.
   */
  private async control<T>(run: (query: Query) => Promise<T>, probe = false): Promise<T> {
    const query = this.query;
    if (!query || this.closed || this.dead) throw new Error("session_closed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("request_timeout")), this.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "request_timeout") {
        if (probe) void this.fail("request_timeout");
        else
          void this.control((q) => q.getContextUsage({ detail: "summary" }), true).catch(() => {});
        throw error;
      }
      if (this.query !== query || this.dead || this.closed) throw new Error("process_died");
      throw new Error("provider_control_error");
    } finally {
      clearTimeout(timer);
    }
  }
  private armTurn() {
    clearTimeout(this.turnTimer);
    if (!this.busy || this.pending.size || this.closed || this.dead) return;
    this.turnTimer = setTimeout(() => {
      void (async () => {
        await this.queue.push({ t: "status", state: "error", detail: "request_timeout" });
        try {
          await this.control((q) => q.getContextUsage({ detail: "summary" }), true);
        } catch {
          await this.fail("request_timeout");
        }
      })();
    }, this.timeoutMs);
  }
  private armIdle() {
    clearTimeout(this.idleTimer);
    if (!this.busy && !this.closed && !this.dead)
      this.idleTimer = setTimeout(() => {
        // Closing the process would kill running background tasks; stay up until they end.
        if (this.background.running().length) return this.armIdle();
        this.connecting = this.stopQuery().finally(() => {
          this.connecting = undefined;
        });
      }, this.idleMs);
  }
  private async fail(code: string) {
    if (this.dead || this.closed) return;
    this.dead = true;
    clearTimeout(this.turnTimer);
    clearTimeout(this.idleTimer);
    this.waiting.length = 0;
    await this.clearPending("process_died");
    if (this.mapper && this.busy)
      await this.queue.push({ t: "turn.done", turnId: this.mapper.turnId, status: "failed" });
    this.busy = false;
    await this.queue.push({ t: "status", state: "error", detail: code });
    await this.stopQuery();
    this.releaseWriter();
  }
  close() {
    this.closing ??= this.finish();
    return this.closing;
  }
  private async finish() {
    this.closed = true;
    clearTimeout(this.turnTimer);
    clearTimeout(this.idleTimer);
    this.waiting.length = 0;
    await this.connecting?.catch(() => {});
    await this.stopQuery();
    await this.chain;
    await this.clearPending("turn_ended");
    this.releaseWriter();
    this.queue.close();
  }
}
