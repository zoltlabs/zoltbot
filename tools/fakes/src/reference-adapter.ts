import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentAdapter,
  type AgentSession,
  AsyncQueue,
  type OpenOptions,
  type SendReceipt,
} from "@zoltbot/adapters-sdk";
import { Logger, Redactor, Supervisor } from "@zoltbot/daemon";
import {
  type AgentDefinition,
  type AgentEvent,
  AgentEventSchema,
  agentEventSchemas,
  type InteractionAnswer,
  parse,
  type UserInput,
} from "@zoltbot/protocol";
import { referenceCapabilities } from "./capabilities.js";

export class ReferenceSession implements AgentSession {
  readonly capabilities = referenceCapabilities;
  nativeId: string | undefined;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly interactions = new Set<string>();
  private readonly turnWaiters: (() => void)[] = [];
  private id = 0;
  private closed = false;
  private chain = Promise.resolve();
  readonly process: Supervisor;
  constructor(
    readonly options: OpenOptions,
    readonly broken?: "drop_final" | "drop_interactions" | "drop_question_other",
    private readonly turnDeadlineMs = 300,
    scopeRedactor?: Redactor,
  ) {
    const redactor =
      scopeRedactor ?? new Redactor(["seeded-secret", options.hostMcp.token, options.cwd]);
    redactor.register(options.hostMcp.token);
    const logger = new Logger(path.join(options.cwd, "adapter.log"), redactor);
    this.process = new Supervisor(
      {
        command: process.execPath,
        args: ["--import", "tsx", path.resolve("tools/fakes/src/reference-provider.ts")],
        cwd: options.cwd,
        env: {
          ...options.env,
          TSX_DISABLE_CACHE: "1",
          TMPDIR: options.cwd,
          HOME: options.cwd,
          HOST_URL: options.hostMcp.url,
          HOST_TOKEN: options.hostMcp.token,
        },
        frameFile: path.join(options.cwd, "frames.jsonl"),
        frameLimitBytes: 8192,
        backoffMs: 5,
        killGraceMs: 25,
      },
      logger,
    );
    this.process.on("stdout", (line: string) => {
      this.chain = this.chain.then(() => this.consume(line));
    });
    this.process.on("exit", () => {
      this.chain = this.chain.then(async () => {
        for (const ref of this.interactions)
          await this.queue.push({
            t: "interaction.cleared",
            nativeRef: ref,
            reason: this.closed ? "turn_ended" : "process_died",
          });
        this.interactions.clear();
        for (const p of this.pending.values()) p.reject(new Error("process_died"));
        this.pending.clear();
        if (!this.closed)
          await this.queue.push({ t: "status", state: "error", detail: "process_died" });
      });
    });
  }
  async open() {
    this.process.start();
    const result = (await this.rpc("open", {
      mode: this.options.mode,
      ...(this.options.nativeId ? { nativeId: this.options.nativeId } : {}),
    })) as { nativeId: string };
    this.nativeId = result.nativeId;
    return this;
  }
  private async consume(line: string) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      await this.queue.push({ t: "status", state: "error", detail: "provider_protocol_error" });
      return;
    }
    if (typeof value.id === "number") {
      const p = this.pending.get(value.id);
      if (p) {
        this.pending.delete(value.id);
        if (value.error) p.reject(new Error(String(value.error)));
        else p.resolve(value.result);
      }
      return;
    }
    if (typeof value.t !== "string" || !(value.t in agentEventSchemas)) return;
    let event: AgentEvent;
    try {
      event = parse(AgentEventSchema, value);
    } catch {
      await this.queue.push({ t: "status", state: "error", detail: "provider_protocol_error" });
      return;
    }
    if (this.broken === "drop_final" && event.t === "message.done") return;
    if (this.broken === "drop_interactions" && event.t === "interaction.requested") return;
    if (
      this.broken === "drop_question_other" &&
      event.t === "interaction.requested" &&
      event.interaction.type === "question"
    )
      event = {
        ...event,
        interaction: {
          ...event.interaction,
          items: event.interaction.items.map((item) => ({ ...item, allowOther: false })),
        },
      };
    if (event.t === "interaction.requested")
      this.interactions.add(event.interaction.nativeRef ?? event.interaction.id);
    if (event.t === "interaction.cleared") this.interactions.delete(event.nativeRef);
    if (event.t === "turn.done") for (const resolve of this.turnWaiters.splice(0)) resolve();
    await this.queue.push(event);
  }
  private rawRpc(method: string, params: unknown): Promise<unknown> {
    const id = ++this.id;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.process.write(JSON.stringify({ id, method, params }));
    return result;
  }
  private rpc(method: string, params: unknown) {
    return this.process.guard(this.rawRpc(method, params), 2000, () => this.rawRpc("probe", {}));
  }
  events() {
    return this.queue;
  }
  async send(input: UserInput, mode: "queue" | "steer"): Promise<SendReceipt> {
    const result = (await this.rpc("send", { input, mode })) as SendReceipt;
    if (result.disposition === "started" && mode === "queue") {
      const turnDone = new Promise<void>((resolve) => this.turnWaiters.push(resolve));
      void this.process
        .guard(turnDone, this.turnDeadlineMs, () => this.rawRpc("probe", {}))
        .catch(async () => {
          if (!this.closed)
            await this.queue.push({ t: "status", state: "error", detail: "request_timeout" });
        });
    }
    return result;
  }
  async interrupt() {
    await this.rpc("interrupt", {});
  }
  async respond(id: string, answer: InteractionAnswer) {
    await this.rpc("respond", { id, answer });
  }
  async setModel(model: string, effort?: string) {
    await this.rpc("setModel", { model, effort });
  }
  async setMode(mode: string) {
    await this.rpc("setMode", { mode });
  }
  async stopBackground(taskId: string) {
    await this.rpc("stopBackground", { taskId });
  }
  async rewindFiles(turnId: string, dryRun: boolean) {
    return (await this.rpc("rewindFiles", { turnId, dryRun })) as {
      canRewind: boolean;
      files: string[];
      insertions?: number;
      deletions?: number;
    };
  }
  async compact(instructions?: string) {
    await this.rpc("compact", { instructions });
  }
  async rename(name: string) {
    await this.rpc("rename", { name });
  }
  async contextUsage() {
    return (await this.rpc("contextUsage", {})) as { used: number; size: number };
  }
  async advanceStream() {
    await this.rpc("advance_stream", {});
  }
  async environment() {
    return (await this.rpc("environment", {})) as Record<string, string>;
  }
  async frameLog() {
    try {
      return readFileSync(this.process.frameFile, "utf8");
    } catch {
      return "";
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.process.close();
    await this.chain;
    for (const resolve of this.turnWaiters.splice(0)) resolve();
    this.queue.close();
  }
}
export class ReferenceAdapter implements AgentAdapter {
  readonly id = "reference";
  constructor(readonly broken?: "drop_final" | "drop_interactions" | "drop_question_other") {}
  manifest() {
    return {
      id: this.id,
      displayName: "Test reference",
      testedVersions: "test-1",
      binaryNames: [process.execPath],
      versionCommand: ["--version"],
      staticCapabilities: referenceCapabilities,
    };
  }
  async probe(_def: AgentDefinition) {
    return { installed: true, broken: false, version: "test-1", login: "signed_in" as const };
  }
  async listNativeSessions(_def: AgentDefinition, _filter: { cwd?: string }) {
    return [];
  }
  async open(_def: AgentDefinition, options: OpenOptions) {
    return new ReferenceSession(options, this.broken).open();
  }
}
