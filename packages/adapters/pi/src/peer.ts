import { EventEmitter } from "node:events";
import type { PiTransport } from "./host.js";
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("provider_protocol_error");
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("provider_protocol_error");
  return value;
}

interface Pending {
  command: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class PiPeer extends EventEmitter {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly pending = new Map<string, Pending>();
  private id = 0;
  private closed = false;
  private writing = Promise.resolve();
  private readonly reading: Promise<void>;
  constructor(
    private readonly transport: PiTransport,
    private readonly timeoutMs = 30000,
  ) {
    super();
    this.reader = transport.input.getReader();
    this.writer = transport.output.getWriter();
    this.reading = this.read();
    void transport.closed.then(() => this.fail("process_died"));
  }
  async write(value: unknown) {
    if (this.closed) throw new Error("session_closed");
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    if (bytes.byteLength > 1048576) throw new Error("frame_too_large");
    const operation = this.writing.then(() => this.writer.write(bytes));
    this.writing = operation.catch(() => this.fail("process_died"));
    return operation;
  }
  async request(
    command: string,
    params: Record<string, unknown>,
    probe = false,
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("session_closed");
    const requestId = `zoltbot-${++this.id}`;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("request_timeout"));
        if (probe || command === "get_state") this.fail("request_timeout");
        else void this.request("get_state", {}, true).catch(() => this.fail("request_timeout"));
      }, this.timeoutMs);
      this.pending.set(requestId, { command, resolve, reject, timer });
    });
    void this.write({ ...params, type: command, id: requestId }).catch(() =>
      this.fail("process_died"),
    );
    return response;
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
          const at = buffer.indexOf("\n"),
            line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (Buffer.byteLength(line) > 1048576) throw new Error("frame_too_large");
          if (line) this.consume(record(JSON.parse(line)));
        }
        if (Buffer.byteLength(buffer) > 1048576) throw new Error("frame_too_large");
      }
    } catch {
      this.fail("provider_protocol_error");
    }
  }
  private consume(frame: Record<string, unknown>) {
    string(frame.type);
    if (frame.type === "response") {
      const id = string(frame.id),
        pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      try {
        if (frame.command !== pending.command) throw new Error("provider_protocol_error");
        if (frame.success === true)
          pending.resolve(frame.data === undefined ? {} : record(frame.data));
        else if (frame.success === false && typeof frame.error === "string")
          pending.reject(new Error("provider_command_error"));
        else throw new Error("provider_protocol_error");
      } catch {
        pending.reject(new Error("provider_protocol_error"));
        this.fail("provider_protocol_error");
      }
      return;
    }
    this.emit("frame", frame);
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
