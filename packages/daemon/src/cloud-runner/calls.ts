import { randomUUID } from "node:crypto";
import { parse } from "@zoltbot/protocol";
import {
  type MacExecProgress,
  MacExecProgressSchema,
  type MacExecRequest,
  MacExecRequestSchema,
  type MacStatusRequest,
  MacStatusRequestSchema,
  type MacStatusResult,
  MacStatusResultSchema,
} from "@zoltbot/runner-protocol";

type Method = "mac.status.request" | "mac.exec.request";
interface Pending {
  method: Method;
  params: MacStatusRequest | MacExecRequest;
  bytes: number;
  resolve(value: unknown): void;
  reject(refused?: boolean): void;
}
/** Reconnectable request transport. The Cell owns durable command idempotency. */
export class RunnerCalls {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(
    private readonly options: { send(frame: unknown): boolean; guard(value: unknown): void },
  ) {}
  call(
    method: "mac.status.request",
    params: MacStatusRequest,
    signal: AbortSignal,
  ): Promise<MacStatusResult>;
  call(
    method: "mac.exec.request",
    params: MacExecRequest,
    signal: AbortSignal,
  ): Promise<MacExecProgress>;
  call(
    method: Method,
    raw: MacStatusRequest | MacExecRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.closed || signal.aborted || this.pending.size >= 16)
      return Promise.reject(new Error("runner_call_unavailable"));
    const params =
      method === "mac.status.request"
        ? parse(MacStatusRequestSchema, structuredClone(raw))
        : parse(MacExecRequestSchema, structuredClone(raw));
    this.options.guard(params);
    const bytes = Buffer.byteLength(JSON.stringify(params));
    if (
      [...this.pending.values()].reduce((sum, request) => sum + request.bytes, bytes) >
      2 * 1024 * 1024
    )
      return Promise.reject(new Error("runner_call_unavailable"));
    const id = `runner-call:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value: unknown, failed = false, refused = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(id);
        if (failed) reject(new Error(refused ? "runner_call_refused" : "runner_call_unavailable"));
        else resolve(value);
      };
      const abort = () => finish(undefined, true);
      const timer = setTimeout(abort, method === "mac.status.request" ? 1900 : 5000);
      this.pending.set(id, {
        method,
        params,
        bytes,
        resolve: (value) => finish(value),
        reject: (refused) => finish(undefined, true, refused),
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  receive(response: { id: string | number; result?: unknown; error?: unknown }) {
    if (typeof response.id !== "string" || !response.id.startsWith("runner-call:")) return false;
    const pending = this.pending.get(response.id);
    if (!pending) return true;
    if (response.error) pending.reject(true);
    else {
      try {
        const result =
          pending.method === "mac.status.request"
            ? parse(MacStatusResultSchema, response.result)
            : parse(MacExecProgressSchema, response.result);
        if (
          pending.method === "mac.exec.request" &&
          "requestId" in result &&
          result.requestId !== pending.params.requestId
        )
          throw new Error();
        if (
          "available" in result &&
          result.available &&
          "targetDeviceId" in pending.params &&
          pending.params.targetDeviceId &&
          result.targetDeviceId !== pending.params.targetDeviceId
        )
          throw new Error();
        if (
          "state" in result &&
          result.state === "complete" &&
          (result.result.taskId !== pending.params.taskId ||
            result.result.requestId !== pending.params.requestId)
        )
          throw new Error();
        this.options.guard(result);
        pending.resolve(result);
      } catch {
        pending.reject();
      }
    }
    return true;
  }
  reconnect() {
    if (this.closed) return;
    for (const [id, request] of this.pending)
      this.send({ jsonrpc: "2.0", id, method: request.method, params: request.params });
  }
  private send(frame: unknown) {
    try {
      this.options.send(frame);
    } catch {}
  }
  close() {
    this.closed = true;
    for (const request of this.pending.values()) request.reject();
    this.pending.clear();
  }
}
