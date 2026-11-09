import { EventEmitter } from "node:events";
import { type CodexSchemas, object } from "./schema.js";

export interface CodexTransport {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): Promise<void>;
}
export class CodexRpcError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: number,
    shuttingDown = false,
  ) {
    super(
      code === -32001
        ? "provider_overloaded"
        : shuttingDown
          ? "server_shutting_down"
          : "provider_request_failed",
    );
    this.retryable = code === -32001 || shuttingDown;
  }
}
interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
/** One peer is shared by every Codex thread using one provider definition and home. */
export class CodexRpc extends EventEmitter {
  private id = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private writing = Promise.resolve();
  private readonly reading: Promise<void>;
  constructor(
    private readonly transport: CodexTransport,
    readonly schemas: CodexSchemas,
    private readonly timeoutMs = 30000,
    private readonly retryBaseMs = 500,
  ) {
    super();
    this.reader = transport.input.getReader();
    this.writer = transport.output.getWriter();
    this.reading = this.read();
    void transport.closed.then(() => this.fail("process_died"));
  }
  private write(value: unknown) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    if (bytes.byteLength > 1048576) return Promise.reject(new Error("frame_too_large"));
    const operation = this.writing.then(() => this.writer.write(bytes));
    this.writing = operation.catch(() => {
      this.fail("process_died");
    });
    return operation;
  }
  async request(method: string, params: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call(method, params);
      } catch (error) {
        if (!(error instanceof CodexRpcError) || !error.retryable || attempt >= 2 || this.closed)
          throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, this.retryBaseMs * 2 ** attempt));
      }
    }
  }
  private async call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error("session_closed");
    const id = ++this.id;
    const message = { id, method, params };
    this.schemas.request(message);
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.timedOut(id), this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    void this.write(message).catch(() => this.fail("process_died"));
    return response;
  }
  async notify(method: string, params?: unknown) {
    if (this.closed) throw new Error("session_closed");
    const message = { method, ...(params === undefined ? {} : { params }) };
    this.schemas.clientNotification(message);
    await this.write(message);
  }
  async respond(id: string | number, method: string, result: unknown) {
    if (this.closed) throw new Error("session_closed");
    this.schemas.serverResult(method, result);
    await this.write({ id, result });
  }
  async reject(id: string | number, code = -32601) {
    await this.write({ id, error: { code, message: "unsupported_server_request" } });
  }
  async initialize(experimentalApi: boolean) {
    const init = object(
      await this.request("initialize", {
        clientInfo: { name: "zoltbot", title: "Zoltbot", version: "0.1.0" },
        capabilities: { experimentalApi },
      }),
    );
    await this.notify("initialized");
    const account = object(await this.request("account/read", { refreshToken: false }));
    return {
      providerVersion: typeof init.userAgent === "string" ? init.userAgent : "unknown",
      account,
    };
  }
  private async read() {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.closed) {
        const result = await this.reader.read();
        if (result.done) {
          this.fail("process_died");
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (Buffer.byteLength(line) > 1048576) throw new Error("frame_too_large");
          if (line) this.consume(object(JSON.parse(line)));
        }
        if (Buffer.byteLength(buffer) > 1048576) throw new Error("frame_too_large");
      }
    } catch {
      this.fail("provider_protocol_error");
    }
  }
  private consume(message: Record<string, unknown>) {
    if (typeof message.method === "string") {
      if ("id" in message) {
        if (typeof message.id !== "number" && typeof message.id !== "string")
          throw new Error("provider_protocol_error");
        if (!this.schemas.serverRequest(message)) {
          void this.reject(message.id).catch(() => this.fail("process_died"));
          return;
        }
        if (this.listenerCount("server_request") === 0) {
          void this.reject(message.id).catch(() => this.fail("process_died"));
          return;
        }
        this.emit("server_request", message);
      } else if (this.schemas.notification(message)) this.emit("notification", message);
      else this.emit("unknown", message.method);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) {
      try {
        const error = object(message.error);
        if (typeof error.code !== "number") throw new Error("provider_protocol_error");
        pending.reject(
          new CodexRpcError(
            error.code,
            error.code === -32600 && error.message === "serverShuttingDown",
          ),
        );
      } catch {
        pending.reject(new Error("provider_protocol_error"));
        this.fail("provider_protocol_error");
      }
      return;
    }
    try {
      this.schemas.result(pending.method, message.result);
      pending.resolve(message.result);
    } catch {
      pending.reject(new Error("provider_protocol_error"));
      this.fail("provider_protocol_error");
    }
  }
  private timedOut(id: number) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(new Error("request_timeout"));
    if (pending.method === "config/read") this.fail("request_timeout");
    else
      void this.request("config/read", { includeLayers: false }).catch(() =>
        this.fail("request_timeout"),
      );
  }
  private fail(code: string) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pending.clear();
    this.emit("fault", code);
    void this.reader.cancel().catch(() => {});
    void this.transport.close().catch(() => {});
  }
  async close() {
    this.fail("session_closed");
    await this.transport.close();
    await this.reading;
    await this.writing;
  }
}
