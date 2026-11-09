import { randomUUID } from "node:crypto";
import {
  type AgentSession,
  AsyncQueue,
  materializeImages,
  nativeCommands,
  type OpenOptions,
  type SendReceipt,
} from "@zoltbot/adapters-sdk";
import type {
  AgentEvent,
  Capabilities,
  InteractionAnswer,
  InteractionDraft,
  UserInput,
} from "@zoltbot/protocol";
import type { PiFile } from "./host.js";
import { PiMapper, piUsage } from "./mapping.js";
import { type PiPeer, record, string } from "./peer.js";
import { piQuestion } from "./questions.js";

export class PiSession implements AgentSession {
  readonly capabilities: Capabilities = {
    resume: true,
    fork: true,
    nativeFork: {
      latest: false,
      boundaries: [],
      callerId: true,
      activation: "active",
      reason: "native_fork_canary_required",
    },
    steer: "native",
    concurrentTurns: false,
    interrupt: "native",
    modes: [],
    models: { selectable: true },
    effort: ["off", "minimal", "low", "medium", "high", "xhigh"],
    approvals: "granular",
    questions: "native",
    questionFeatures: { multi: false, other: true, recommended: false, maxItems: 1 },
    planReview: "none",
    elicitation: "none",
    usage: { tokens: true, cost: true, context: true, cache: true },
    compaction: { auto: true, manual: true, events: true },
    hostTools: "mcp_http",
    images: true,
    nativeSessions: { list: false, adopt: true, visibleInOfficialApps: "no" },
    worktreeAware: true,
  };
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly waiting: UserInput[] = [];
  private readonly pending = new Map<
    string,
    { nativeId: string; question?: ReturnType<typeof piQuestion> }
  >();
  private mapper: PiMapper | undefined;
  private chain = Promise.resolve();
  private starting: Promise<SendReceipt> | undefined;
  private cleaning: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly started = new Set<string>();
  private busy = false;
  private dead = false;
  private closed = false;
  private readyProof = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly peer: PiPeer,
    readonly nativeId: string,
    private readonly options: OpenOptions,
    private readonly files: PiFile[],
    private readonly release: () => void,
    private readonly timeoutMs = 30000,
    private readonly provider: string | undefined = undefined,
  ) {
    peer.on("frame", (frame: Record<string, unknown>) => {
      this.chain = this.chain
        .then(() => this.receive(frame))
        .catch(() => this.fail("provider_protocol_error"));
    });
    peer.on("fault", (code: string) => {
      void this.fail(code);
    });
  }
  async ready(nonce: string, extensionPath: string, providerVersion: string) {
    const state = await this.peer.request("get_state", {});
    if (state.sessionId !== this.nativeId) throw new Error("native_session_mismatch");
    if (this.provider && state.model && record(state.model).provider !== this.provider)
      throw new Error("provider_model_unavailable");
    const commands = await this.peer.request("get_commands", {});
    if (
      !Array.isArray(commands.commands) ||
      !commands.commands.some((raw) => {
        const command = record(raw);
        return (
          command.name === "zoltbot_ready" &&
          command.source === "extension" &&
          record(command.sourceInfo).path === extensionPath
        );
      })
    )
      throw new Error("permission_gate_unavailable");
    this.capabilities.slashCommands = nativeCommands(commands.commands);
    this.readyNonce = nonce;
    const response = await this.peer.request("prompt", { message: "/zoltbot_ready" });
    await this.chain;
    if (response.disposition !== "handled" || !this.readyProof || this.dead)
      throw new Error("permission_gate_unavailable");
    const models = await this.peer.request("get_available_models", {});
    this.capabilities.models.list = (Array.isArray(models.models) ? models.models : [])
      .filter((raw) => !this.provider || record(raw).provider === this.provider)
      .map((raw) => {
        const model = record(raw);
        return {
          id: `${string(model.provider)}:${string(model.id)}`,
          name: typeof model.name === "string" ? model.name : string(model.id),
        };
      });
    if (this.options.name) await this.rename(this.options.name);
    await this.queue.push({
      t: "session.ready",
      nativeId: this.nativeId,
      capabilities: structuredClone(this.capabilities),
      providerVersion,
    });
  }
  private readyNonce = "";
  events() {
    return this.queue;
  }
  private input(input: UserInput) {
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    const texts: string[] = [];
    for (const part of input) {
      if (part.type === "text") texts.push(part.text);
      else if (part.type === "file") texts.push(`@${part.path}`);
      else if (part.base64 && part.mimeType)
        images.push({ type: "image", data: part.base64, mimeType: part.mimeType });
      else throw new Error("unsupported_input_block");
    }
    return { message: texts.join("\n"), ...(images.length ? { images } : {}) };
  }
  async send(input: UserInput, mode: "queue" | "steer"): Promise<SendReceipt> {
    if (this.closed || this.dead) throw new Error("session_closed");
    input = await materializeImages(input);
    const params = this.input(input);
    if (this.busy) {
      if (mode === "steer") {
        await this.starting;
        await this.peer.request("steer", params);
        return { disposition: "started", ...(this.mapper ? { id: this.mapper.turnId } : {}) };
      }
      this.waiting.push(input);
      await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
      return { disposition: "queued" };
    }
    const operation = this.begin(params);
    this.starting = operation;
    return operation.finally(() => {
      if (this.starting === operation) this.starting = undefined;
    });
  }
  private async emitStarted(id: string) {
    if (!this.started.has(id)) {
      this.started.add(id);
      await this.queue.push({ t: "turn.started", turnId: id });
    }
  }
  private async begin(params: Record<string, unknown>): Promise<SendReceipt> {
    this.busy = true;
    const turnId = randomUUID();
    this.mapper = new PiMapper(turnId);
    try {
      const response = await this.peer.request("prompt", params);
      if (response.disposition === "handled") {
        if (!this.started.has(turnId)) {
          this.busy = false;
          this.mapper = undefined;
        }
        return { disposition: "handled" };
      }
      if (response.disposition !== "started" && response.disposition !== "queued")
        throw new Error("provider_protocol_error");
      await this.emitStarted(turnId);
      this.armTimer();
      return { disposition: response.disposition, id: turnId };
    } catch (error) {
      await this.fail("turn_start_failed");
      throw error;
    }
  }
  private async receive(frame: Record<string, unknown>) {
    if (this.closed || this.dead) return;
    if (frame.type === "extension_error") {
      await this.fail("permission_gate_failed");
      return;
    }
    if (frame.type === "extension_ui_request") {
      await this.interaction(frame);
      return;
    }
    if (!this.mapper) {
      if (
        [
          "compaction_start",
          "compaction_end",
          "auto_compaction_start",
          "auto_compaction_end",
        ].includes(String(frame.type))
      )
        for (const event of new PiMapper("compaction").frame(frame)) await this.queue.push(event);
      return;
    }
    this.armTimer();
    if (["agent_start", "turn_start", "message_start"].includes(String(frame.type)))
      await this.emitStarted(this.mapper.turnId);
    for (const event of this.mapper.frame(frame)) {
      if (event.t === "turn.done") {
        this.mapper = undefined;
        this.busy = false;
        clearTimeout(this.timer);
        await this.clearPending("turn_ended");
        try {
          await this.refreshUsage();
        } catch {}
      }
      await this.queue.push(event);
      if (event.t === "turn.done" && !this.dead) {
        const next = this.waiting.shift();
        if (next) {
          await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
          void this.send(next, "queue").catch(() => {});
        }
      }
    }
  }
  private async interaction(frame: Record<string, unknown>) {
    if (frame.method === "notify") {
      if (frame.message === `zoltbot_ready:${this.readyNonce}` && this.readyNonce)
        this.readyProof = true;
      return;
    }
    const nativeId = string(frame.id);
    if ([...this.pending.values()].some((pending) => pending.nativeId === nativeId)) return;
    if (["select", "input"].includes(String(frame.method)) && this.mapper) {
      try {
        const id = randomUUID();
        const question = piQuestion(frame, {
          id,
          ...this.options.identity,
          turnId: this.mapper.turnId,
        });
        this.pending.set(id, { nativeId, question });
        clearTimeout(this.timer);
        await this.queue.push({ t: "interaction.requested", interaction: question.interaction });
      } catch {
        await this.peer.write({ type: "extension_ui_response", id: nativeId, cancelled: true });
      }
      return;
    }
    if (frame.method !== "confirm" || !this.mapper) {
      await this.peer.write({ type: "extension_ui_response", id: nativeId, cancelled: true });
      return;
    }
    const id = randomUUID();
    const native =
      frame.title === "Zoltbot approval" ? record(JSON.parse(string(frame.message))) : undefined;
    const input = native ? record(native.input) : { message: string(frame.message) };
    const context: InteractionDraft["context"] = {
      toolInput: input,
      ...(native && ["write", "edit"].includes(String(native.toolName))
        ? { toolKind: "edit" as const }
        : {}),
      ...(native && typeof native.toolName === "string" ? { toolName: native.toolName } : {}),
      ...(native && typeof native.cwd === "string" ? { cwd: native.cwd } : {}),
      ...(typeof input.command === "string" ? { command: input.command } : {}),
      ...(typeof input.path === "string" ? { paths: [input.path] } : {}),
    };
    this.pending.set(id, { nativeId });
    clearTimeout(this.timer);
    await this.queue.push({
      t: "interaction.requested",
      interaction: {
        id,
        ...this.options.identity,
        turnId: this.mapper.turnId,
        nativeRef: id,
        type: "approval",
        chain: [],
        urgency: "blocking",
        title: typeof frame.title === "string" ? frame.title : "Approval",
        context,
        items: [
          {
            id: "approval",
            prompt: "Allow this action?",
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
          },
        ],
      },
    });
  }
  async respond(id: string, answer: InteractionAnswer) {
    const pending = this.pending.get(id);
    if (!pending || this.closed || this.dead) throw new Error("interaction_not_pending");
    const response = pending.question
      ? pending.question.reply(answer)
      : {
          confirmed:
            answer.action === "accept" &&
            (answer.choice === undefined || answer.choice === "allow_once"),
        };
    this.pending.delete(id);
    await this.peer.write({ type: "extension_ui_response", id: pending.nativeId, ...response });
    await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason: "provider_resolved" });
    this.armTimer();
  }
  private async clearPending(reason: "turn_ended" | "process_died") {
    const ids = [...this.pending.keys()];
    this.pending.clear();
    for (const id of ids)
      await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason });
  }
  async interrupt() {
    this.waiting.length = 0;
    await this.queue.push({ t: "queue.updated", pending: 0 });
    await this.starting;
    if (this.busy && !this.closed && !this.dead) await this.peer.request("abort", {});
  }
  async setModel(model: string, effort?: string) {
    const [provider, ...parts] = model.split(":");
    if (!provider || !parts.join(":")) throw new Error("model_provider_required");
    if (this.provider && provider !== this.provider) throw new Error("unsupported_model");
    if (this.busy) throw new Error("session_busy");
    if (effort && !this.capabilities.effort.includes(effort)) throw new Error("unsupported_effort");
    await this.peer.request("set_model", { provider, modelId: parts.join(":") });
    if (effort) {
      if (!this.capabilities.effort.includes(effort)) throw new Error("unsupported_effort");
      await this.peer.request("set_thinking_level", { level: effort });
    }
  }
  async setMode(_mode: string) {
    throw new Error("unsupported_mode");
  }
  async compact(instructions?: string) {
    if (this.busy) throw new Error("session_busy");
    await this.peer.request("compact", instructions ? { customInstructions: instructions } : {});
  }
  async rename(name: string) {
    if (!name) throw new Error("invalid_name");
    await this.peer.request("set_session_name", { name });
  }
  private async stats() {
    return this.peer.request("get_session_stats", {});
  }
  private async refreshUsage() {
    const stats = await this.stats();
    const tokens = record(stats.tokens);
    await this.queue.push({
      t: "usage.updated",
      usage: piUsage({ ...tokens, cost: stats.cost }, true),
    });
  }
  async contextUsage() {
    const stats = await this.stats();
    if (!stats.contextUsage) return undefined;
    const context = record(stats.contextUsage);
    const result: { used?: number; size?: number } = {};
    if (context.tokens !== null && context.tokens !== undefined) {
      if (!Number.isSafeInteger(context.tokens) || Number(context.tokens) < 0)
        throw new Error("provider_protocol_error");
      result.used = Number(context.tokens);
    }
    if (context.contextWindow !== undefined) {
      if (!Number.isSafeInteger(context.contextWindow) || Number(context.contextWindow) < 1)
        throw new Error("provider_protocol_error");
      result.size = Number(context.contextWindow);
    }
    return result;
  }
  private armTimer() {
    clearTimeout(this.timer);
    if (!this.busy || this.pending.size || this.dead || this.closed) return;
    this.timer = setTimeout(() => {
      void (async () => {
        await this.queue.push({ t: "status", state: "error", detail: "request_timeout" });
        try {
          await this.peer.request("get_state", {}, true);
        } catch {
          await this.fail("request_timeout");
        }
      })();
    }, this.timeoutMs);
  }
  private async fail(code: string) {
    if (this.closed || this.dead) return;
    this.dead = true;
    clearTimeout(this.timer);
    this.waiting.length = 0;
    await this.clearPending("process_died");
    if (this.mapper && this.busy)
      await this.queue.push({ t: "turn.done", turnId: this.mapper.turnId, status: "failed" });
    this.mapper = undefined;
    this.busy = false;
    await this.queue.push({ t: "status", state: "error", detail: code });
    await this.clean();
    this.release();
  }
  private clean(): Promise<void> {
    this.cleaning ??= (async () => {
      await this.peer.close();
      for (const file of this.files) await file.dispose();
    })();
    return this.cleaning;
  }
  close() {
    this.closing ??= this.finish();
    return this.closing;
  }
  private async finish() {
    this.closed = true;
    clearTimeout(this.timer);
    this.waiting.length = 0;
    await this.clean();
    await this.starting?.catch(() => {});
    await this.chain;
    await this.clearPending("turn_ended");
    this.release();
    this.queue.close();
  }
}
