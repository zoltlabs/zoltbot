import { randomUUID } from "node:crypto";
import {
  type AgentSession,
  AsyncQueue,
  type OpenOptions,
  type SendReceipt,
} from "@zoltbot/adapters-sdk";
import type { AgentEvent, Capabilities, InteractionAnswer, UserInput } from "@zoltbot/protocol";
import type { CodexPeer } from "./index.js";
import { codexAnswer, codexInteraction } from "./interactions.js";
import { codexNotification } from "./mapping.js";
import { object } from "./schema.js";

interface PendingRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}
export class CodexSession implements AgentSession {
  readonly capabilities: Capabilities = {
    resume: true,
    fork: true,
    nativeFork: {
      latest: false,
      boundaries: [],
      callerId: false,
      activation: "active",
      reason: "native_fork_canary_required",
    },
    steer: "native",
    concurrentTurns: false,
    interrupt: "native",
    modes: [],
    models: { selectable: true },
    effort: [],
    approvals: "granular",
    questions: "native",
    planReview: "none",
    elicitation: "form",
    usage: { tokens: true, cost: false, context: true, cache: true },
    compaction: { auto: true, manual: true, events: true },
    hostTools: "mcp_http",
    images: true,
    nativeSessions: { list: true, adopt: true, visibleInOfficialApps: "unknown" },
    worktreeAware: true,
  };
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly waiting: UserInput[] = [];
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();
  private chain = Promise.resolve();
  private starting: Promise<SendReceipt> | undefined;
  private busy = false;
  private current: string | undefined;
  private closed = false;
  private dead = false;
  private compacting = false;
  private context: { used?: number; size?: number } | undefined;
  private overrides: { model: string; effort?: string } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly peer: CodexPeer,
    readonly nativeId: string,
    readonly options: OpenOptions,
    private readonly timeoutMs = 30000,
    private readonly releaseWriter: () => void = () => {},
  ) {}
  async ready() {
    if (this.peer.providerVersion === "0.166.0")
      this.capabilities.nativeFork = {
        latest: true,
        boundaries: [],
        callerId: false,
        activation: "active",
      };
    if (this.options.name) await this.rename(this.options.name);
    await this.queue.push({
      t: "session.ready",
      nativeId: this.nativeId,
      capabilities: this.capabilities,
      providerVersion: this.peer.providerVersion,
    });
  }
  events() {
    return this.queue;
  }
  private input(input: UserInput) {
    return input.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "file") return { type: "text", text: `@${part.path}` };
      if (part.path) return { type: "localImage", path: part.path };
      if (part.base64 && part.mimeType)
        return { type: "image", url: `data:${part.mimeType};base64,${part.base64}` };
      throw new Error("unsupported_input_block");
    });
  }
  private async emitStarted(turnId: string) {
    if (this.started.has(turnId)) return;
    this.started.add(turnId);
    await this.queue.push({ t: "turn.started", turnId });
  }
  async send(input: UserInput, mode: "queue" | "steer"): Promise<SendReceipt> {
    if (this.closed || this.dead) throw new Error("session_closed");
    if (this.busy) {
      if (mode === "steer") {
        await this.starting;
        if (this.current) {
          const response = object(
            await this.peer.rpc.request("turn/steer", {
              threadId: this.nativeId,
              expectedTurnId: this.current,
              input: this.input(input),
            }),
          );
          return { disposition: "started", id: String(response.turnId) };
        }
      }
      this.waiting.push(input);
      await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
      return { disposition: "queued" };
    }
    return this.launch(input);
  }
  private launch(input: UserInput) {
    const operation = this.begin(input);
    this.starting = operation;
    return operation.finally(() => {
      if (this.starting === operation) this.starting = undefined;
    });
  }
  private async begin(input: UserInput): Promise<SendReceipt> {
    this.busy = true;
    try {
      const response = object(
        await this.peer.rpc.request("turn/start", {
          threadId: this.nativeId,
          input: this.input(input),
          ...this.overrides,
        }),
      );
      const turnId = object(response.turn).id;
      if (typeof turnId !== "string") throw new Error("provider_protocol_error");
      this.overrides = undefined;
      if (!this.completed.has(turnId)) this.current = turnId;
      await this.emitStarted(turnId);
      this.armTimer();
      return { disposition: "started", id: turnId };
    } catch (error) {
      this.busy = false;
      await this.queue.push({ t: "status", state: "error", detail: "turn_start_failed" });
      throw error;
    }
  }
  receive(method: string, params: Record<string, unknown>) {
    this.chain = this.chain
      .then(async () => {
        if (
          this.closed ||
          this.dead ||
          (typeof params.threadId === "string" && params.threadId !== this.nativeId)
        )
          return;
        if (method === "serverRequest/resolved") {
          for (const [id, request] of this.pending)
            if (request.id === params.requestId) {
              this.pending.delete(id);
              await this.queue.push({
                t: "interaction.cleared",
                nativeRef: id,
                reason: "provider_resolved",
              });
            }
          return;
        }
        const events = codexNotification(method, params, this.compacting ? "manual" : "auto");
        for (const event of events) {
          if (event.t === "turn.started") {
            this.busy = true;
            this.current = event.turnId;
            await this.emitStarted(event.turnId);
            continue;
          }
          if (event.t === "usage.updated" && event.usage.contextUsed !== undefined)
            this.context = {
              used: event.usage.contextUsed,
              ...(event.usage.contextSize !== undefined ? { size: event.usage.contextSize } : {}),
            };
          if (event.t === "turn.done") {
            if (this.completed.has(event.turnId)) continue;
            this.completed.add(event.turnId);
            this.busy = false;
            this.current = undefined;
            clearTimeout(this.timer);
            await this.clearPending("turn_ended");
          }
          await this.queue.push(event);
          if (event.t === "compaction" && event.state === "done") this.compacting = false;
        }
        if (method === "turn/completed" && !this.dead) {
          const next = this.waiting.shift();
          if (next) {
            await this.queue.push({ t: "queue.updated", pending: this.waiting.length });
            void this.launch(next).catch(() => {});
          }
        }
        this.armTimer();
      })
      .catch(() => this.fail("provider_protocol_error"));
    return this.chain;
  }
  serverRequest(message: Record<string, unknown>) {
    this.chain = this.chain
      .then(async () => {
        if (this.closed || this.dead) return;
        const nativeId = message.id;
        if (typeof nativeId !== "string" && typeof nativeId !== "number")
          throw new Error("provider_protocol_error");
        const method = String(message.method),
          params = object(message.params),
          id = randomUUID();
        let interaction: ReturnType<typeof codexInteraction>;
        try {
          interaction = codexInteraction(method, params, { id, ...this.options.identity });
        } catch {
          await this.peer.rpc.reject(nativeId);
          return;
        }
        this.pending.set(id, { id: nativeId, method, params });
        clearTimeout(this.timer);
        await this.queue.push({ t: "interaction.requested", interaction });
      })
      .catch(() => this.fail("provider_protocol_error"));
    return this.chain;
  }
  async respond(id: string, answer: InteractionAnswer) {
    const pending = this.pending.get(id);
    if (!pending || this.closed || this.dead) throw new Error("interaction_not_pending");
    const result = codexAnswer(pending.method, pending.params, answer);
    this.pending.delete(id);
    await this.peer.rpc.respond(pending.id, pending.method, result);
    await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason: "provider_resolved" });
    this.armTimer();
  }
  private async clearPending(reason: "turn_ended" | "process_died") {
    for (const [id] of this.pending)
      await this.queue.push({ t: "interaction.cleared", nativeRef: id, reason });
    this.pending.clear();
  }
  async interrupt() {
    this.waiting.length = 0;
    await this.queue.push({ t: "queue.updated", pending: 0 });
    await this.starting;
    if (this.current && !this.dead && !this.closed)
      await this.peer.rpc.request("turn/interrupt", {
        threadId: this.nativeId,
        turnId: this.current,
      });
  }
  async setModel(model: string, effort?: string) {
    if (!model || this.closed || this.dead) throw new Error("unsupported_model");
    const overrides = { model, ...(effort ? { effort } : {}) };
    this.peer.rpc.schemas.request({
      id: 0,
      method: "turn/start",
      params: {
        threadId: this.nativeId,
        input: [{ type: "text", text: "validation" }],
        ...overrides,
      },
    });
    this.overrides = overrides;
  }
  async setMode(_mode: string) {
    throw new Error("unsupported_mode");
  }
  async compact(_instructions?: string) {
    if (this.closed || this.dead) throw new Error("session_closed");
    if (this.busy) throw new Error("session_busy");
    this.compacting = true;
    try {
      await this.peer.rpc.request("thread/compact/start", { threadId: this.nativeId });
      await this.chain;
    } catch (error) {
      this.compacting = false;
      throw error;
    }
  }
  async rename(name: string) {
    await this.peer.rpc.request("thread/name/set", { threadId: this.nativeId, name });
  }
  async contextUsage() {
    return this.context;
  }
  private armTimer() {
    clearTimeout(this.timer);
    if (!this.busy || this.pending.size || this.closed || this.dead) return;
    this.timer = setTimeout(() => {
      void (async () => {
        await this.queue.push({ t: "status", state: "error", detail: "request_timeout" });
        try {
          await this.peer.rpc.request("config/read", { includeLayers: false });
        } catch {
          await this.peer.rpc.close();
        }
      })();
    }, this.timeoutMs);
  }
  async fail(code: string) {
    if (this.dead || this.closed) return;
    this.dead = true;
    clearTimeout(this.timer);
    this.waiting.length = 0;
    await this.clearPending("process_died");
    if (this.current)
      await this.queue.push({ t: "turn.done", turnId: this.current, status: "failed" });
    await this.queue.push({ t: "status", state: "error", detail: code });
    await this.peer.rpc.close();
    this.releaseWriter();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.starting?.catch(() => {});
    this.waiting.length = 0;
    for (const pending of this.pending.values()) {
      try {
        await this.peer.rpc.respond(
          pending.id,
          pending.method,
          codexAnswer(pending.method, pending.params, {
            action: "cancel",
            by: { kind: "system", id: "session-close" },
            at: new Date().toISOString(),
          }),
        );
      } catch {}
    }
    await this.clearPending("turn_ended");
    if (this.current && !this.dead) {
      try {
        await this.peer.rpc.request("turn/interrupt", {
          threadId: this.nativeId,
          turnId: this.current,
        });
      } catch {}
    }
    this.peer.owners.delete(this.nativeId);
    this.releaseWriter();
    await this.peer.release();
    await this.chain;
    this.queue.close();
  }
}
