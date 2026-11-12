import { randomUUID } from "node:crypto";
import { parse } from "@zoltbot/protocol";
import {
  type MacExecProgress,
  type MacExecRequest,
  MacExecRequestSchema,
  type MacStatusRequest,
  MacStatusRequestSchema,
  type MacStatusResult,
  parseRunnerMessage,
  RunnerAckSchema,
  type RunnerCommand,
  RunnerCommandSchema,
  type RunnerHello,
  RunnerHelloSchema,
  type RunnerLease,
  RunnerLeaseSchema,
} from "@zoltbot/runner-protocol";
import WebSocket from "ws";
import { RunnerCalls } from "./calls.js";
import { RunnerOutbox } from "./outbox.js";

/** An explicit credential-service refusal, never a transient network failure. */
export class RunnerAccessRevokedError extends Error {
  constructor() {
    super("runner_access_revoked");
  }
}
export interface RunnerCredentials {
  url: string;
  token: string;
  expiresAt: number;
}
export interface ConnectedTask {
  /** Whether this host still owns a ready native session for private handoffs. */
  ready?(): boolean;
  update(lease: RunnerLease): Promise<void>;
  command(command: RunnerCommand, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
interface TaskEntry {
  lease: RunnerLease;
  outbox: RunnerOutbox;
  runtime?: ConnectedTask;
  sent: number;
  ready: boolean;
}
interface Session {
  socket: WebSocket;
  cursors: Map<string, number>;
  initialized: Set<string>;
  queuedBytes: number;
}
const maximumFrame = 2 * 1024 * 1024;
export interface RunnerConnectionOptions {
  orgId: string;
  taskId?: string;
  hello: RunnerHello;
  outboxDirectory: string;
  guard(value: unknown): void;
  credentials(signal: AbortSignal): Promise<RunnerCredentials>;
  /** Hosts must cancel startup/commands when the connection is permanently closed. */
  task(
    lease: RunnerLease,
    outbox: RunnerOutbox,
    publish: () => void,
    signal: AbortSignal,
  ): Promise<ConnectedTask>;
  macExec?(request: MacExecRequest, signal: AbortSignal): Promise<unknown>;
  macStatus?(request: MacStatusRequest, signal: AbortSignal): Promise<unknown>;
  status?(code: string): void;
  /** Localhost-only test servers; production connections always use TLS. */
  allowLoopback?: boolean;
  retryBaseMs?: number;
}

/** Transport only: execution and signed approvals belong to the task/bridge hosts. */
export class RunnerConnection {
  private readonly hello: RunnerHello;
  private readonly calls: RunnerCalls;
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly lifetime = new AbortController();
  private session: Session | undefined;
  private chain = Promise.resolve();
  private readonly bridgeJobs = new Map<
    string,
    {
      body: string;
      bytes: number;
      replies: Map<string, { session: Session; id: string | number }>;
      work: Promise<void>;
    }
  >();
  private readonly statusJobs = new Set<Promise<void>>();
  private stopped = false;
  private loop: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryResolve: (() => void) | undefined;
  constructor(private readonly options: RunnerConnectionOptions) {
    this.hello = parse(RunnerHelloSchema, structuredClone(options.hello));
    this.calls = new RunnerCalls({
      guard: options.guard,
      send: (frame) => (this.session ? this.send(this.session, frame) : false),
    });
    if (this.hello.kind === "sandbox" && !options.taskId) throw new Error("runner_task_required");
  }
  start() {
    if (this.stopped) throw new Error("runner_connection_closed");
    this.loop ??= this.run();
  }
  private status(code: string) {
    try {
      this.options.status?.(code);
    } catch {}
  }
  private endpoint(credentials: RunnerCredentials) {
    const url = new URL(credentials.url);
    const local =
      this.options.allowLoopback &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.protocol === "ws:";
    if (
      (url.protocol !== "wss:" && !local) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/v1/orgs/${encodeURIComponent(this.options.orgId)}/connect` ||
      !credentials.token ||
      credentials.token.length > 8192 ||
      /[\r\n]/.test(credentials.token) ||
      !Number.isFinite(credentials.expiresAt) ||
      credentials.expiresAt <= Date.now() + 1000
    )
      throw new Error("runner_credentials_invalid");
    return url.toString();
  }
  private async run() {
    let failures = 0;
    while (!this.stopped) {
      this.controller = new AbortController();
      const controller = this.controller;
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        const credentials = await Promise.race([
          this.options.credentials(controller.signal),
          aborted,
        ]);
        clearTimeout(timer);
        if (this.stopped) break;
        const started = Date.now();
        await this.connect(credentials);
        failures = Date.now() - started >= 30000 ? 0 : failures + 1;
      } catch (error) {
        if (error instanceof RunnerAccessRevokedError) {
          this.status("runner_access_revoked");
          void this.close().catch(() => this.status("runner_cleanup_required"));
          return;
        }
        failures++;
        if (!this.stopped) this.status("runner_connection_unavailable");
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        this.retryResolve = resolve;
        const base = Math.max(10, this.options.retryBaseMs ?? 500);
        this.retryTimer = setTimeout(resolve, Math.min(30000, base * 2 ** Math.min(failures, 6)));
      });
      this.retryResolve = undefined;
      this.retryTimer = undefined;
    }
  }
  private connect(credentials: RunnerCredentials) {
    const endpoint = this.endpoint(credentials);
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: { Authorization: `Bearer ${credentials.token}` },
        maxPayload: maximumFrame,
        handshakeTimeout: 10000,
        followRedirects: false,
      });
      const session: Session = {
        socket,
        cursors: new Map(),
        initialized: new Set(),
        queuedBytes: 0,
      };
      this.session = session;
      const helloDeadline = setTimeout(() => socket.terminate(), 10000);
      const heartbeat = setInterval(() => {
        this.heartbeat(session);
      }, 15000);
      const renewal = setTimeout(
        () => socket.close(1012, "renew"),
        Math.max(1000, credentials.expiresAt - Date.now() - 30000),
      );
      socket.on("open", () => this.request(session, "runner.hello", this.hello, "hello"));
      socket.on("message", (raw, binary) => {
        if (this.session !== session || this.stopped) return;
        try {
          if (binary) throw new Error("runner_frame_invalid");
          const text = raw.toString();
          if (Buffer.byteLength(text) > maximumFrame) throw new Error("runner_frame_invalid");
          const message = parseRunnerMessage(JSON.parse(text));
          if (!("method" in message) && message.id === "hello" && "result" in message) {
            const result = message.result;
            if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true)
              throw new Error("runner_hello_refused");
            clearTimeout(helloDeadline);
          }
          this.receive(session, message, Buffer.byteLength(text));
        } catch {
          this.status("runner_frame_refused");
          socket.close(1008, "refused");
        }
      });
      socket.on("unexpected-response", (_request, response) => {
        const revoked = [401, 403, 410].includes(response.statusCode ?? 0);
        response.destroy();
        if (revoked) reject(new RunnerAccessRevokedError());
        else resolve();
        socket.terminate();
      });
      socket.on("error", () => {
        this.status("runner_connection_unavailable");
        socket.terminate();
      });
      socket.on("close", (code, reason) => {
        clearTimeout(helloDeadline);
        clearInterval(heartbeat);
        clearTimeout(renewal);
        if (this.session === session) this.session = undefined;
        if (
          code === 1008 &&
          ["forbidden", "unauthorized", "access_revoked"].includes(reason.toString())
        )
          reject(new RunnerAccessRevokedError());
        else resolve();
      });
    });
  }
  private send(session: Session, value: unknown) {
    if (this.stopped || this.session !== session || session.socket.readyState !== WebSocket.OPEN)
      return false;
    if (session.socket.bufferedAmount > maximumFrame * 2) {
      session.socket.close(1013, "backpressure");
      return false;
    }
    try {
      this.options.guard(value);
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > maximumFrame) throw new Error("runner_frame_too_large");
      session.socket.send(text);
      return true;
    } catch {
      this.status("runner_frame_refused");
      session.socket.close(1008, "refused");
      return false;
    }
  }
  private request(session: Session, method: string, params: unknown, id: string = randomUUID()) {
    return this.send(session, { jsonrpc: "2.0", id, method, params });
  }
  private receive(session: Session, message: ReturnType<typeof parseRunnerMessage>, bytes: number) {
    if (!("method" in message)) {
      if (this.calls.receive(message)) return;
      if ("error" in message) throw new Error("runner_request_refused");
      if (message.id === "hello") {
        this.status("runner_connected");
        this.heartbeat(session);
        this.calls.reconnect();
      }
      return;
    }
    if (message.method === "runner.ack") {
      const ack = parse(RunnerAckSchema, message.params);
      if (!session.cursors.has(ack.taskId) && session.cursors.size >= 1024)
        throw new Error("runner_cursor_limit");
      session.cursors.set(ack.taskId, ack.runnerSeq);
      const task = this.tasks.get(ack.taskId);
      if (task) {
        if (!session.initialized.has(ack.taskId)) {
          task.outbox.reconcile(ack.runnerSeq);
          session.initialized.add(ack.taskId);
          task.sent = ack.runnerSeq;
        } else {
          if (ack.runnerSeq > task.sent) throw new Error("runner_ack_invalid");
          task.outbox.acknowledge(ack.runnerSeq);
        }
        this.pump(session, task);
      }
      return;
    }
    if (["mac.exec.request", "mac.status.request"].includes(message.method)) {
      this.bridge(session, message, bytes);
      return;
    }
    if (!["runner.lease", "runner.command"].includes(message.method))
      throw new Error("runner_method_refused");
    if (session.queuedBytes + bytes > maximumFrame * 2) throw new Error("runner_queue_full");
    session.queuedBytes += bytes;
    this.chain = this.chain
      .then(async () => {
        if (this.session !== session || this.stopped) return;
        if (message.method === "runner.lease") {
          await this.lease(session, parse(RunnerLeaseSchema, message.params));
          return;
        }
        try {
          let result: unknown;
          if (message.method === "runner.command") {
            const command = parse(RunnerCommandSchema, message.params);
            const task = this.tasks.get(command.taskId);
            if (!task?.runtime || command.leaseId !== task.lease.leaseId)
              throw new Error("runner_lease_required");
            result = await task.runtime.command(command, this.lifetime.signal);
          }
          this.send(session, { jsonrpc: "2.0", id: message.id, result });
        } catch {
          this.send(session, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "runner_command_failed" },
          });
        }
      })
      .catch(() => {
        this.status("runner_lease_refused");
        session.socket.close(1008, "refused");
      })
      .finally(() => {
        session.queuedBytes -= bytes;
      });
  }
  /** A long approved shell must not block status, task commands or reconnect replay. */
  private bridge(
    session: Session,
    message: Extract<ReturnType<typeof parseRunnerMessage>, { method: string }>,
    bytes: number,
  ) {
    const fail = () =>
      this.send(session, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "runner_command_failed" },
      });
    if (this.hello.kind !== "mac") {
      fail();
      return;
    }
    if (message.method === "mac.status.request") {
      if (!this.options.macStatus || this.statusJobs.size >= 8) {
        fail();
        return;
      }
      const input = parse(MacStatusRequestSchema, message.params);
      const work = (async () => {
        try {
          this.send(session, {
            jsonrpc: "2.0",
            id: message.id,
            result: await this.options.macStatus?.(input, this.lifetime.signal),
          });
        } catch {
          fail();
        }
      })();
      this.statusJobs.add(work);
      void work.finally(() => this.statusJobs.delete(work));
      return;
    }
    if (!this.options.macExec) {
      fail();
      return;
    }
    const input = parse(MacExecRequestSchema, message.params),
      key = JSON.stringify([input.taskId, input.requestId]),
      body = JSON.stringify(input),
      replyKey = JSON.stringify([typeof message.id, message.id]);
    const existing = this.bridgeJobs.get(key);
    if (existing) {
      if (
        existing.body !== body ||
        (existing.replies.size >= 16 && !existing.replies.has(replyKey))
      ) {
        fail();
        return;
      }
      existing.replies.set(replyKey, { session, id: message.id });
      return;
    }
    if (
      this.bridgeJobs.size >= 8 ||
      [...this.bridgeJobs.values()].reduce((sum, job) => sum + job.bytes, bytes) > maximumFrame * 2
    ) {
      fail();
      return;
    }
    const job = {
      body,
      bytes,
      replies: new Map([[replyKey, { session, id: message.id }]]),
      work: Promise.resolve(),
    };
    job.work = Promise.resolve()
      .then(async () => {
        let response: { result: unknown } | { error: { code: number; message: string } };
        try {
          response = { result: await this.options.macExec?.(input, this.lifetime.signal) };
        } catch {
          response = { error: { code: -32000, message: "runner_command_failed" } };
        }
        for (const reply of job.replies.values())
          this.send(reply.session, { jsonrpc: "2.0", id: reply.id, ...response });
      })
      .finally(() => this.bridgeJobs.delete(key));
    this.bridgeJobs.set(key, job);
  }
  private async lease(session: Session, lease: RunnerLease) {
    const execution = lease.execution;
    if (
      !execution ||
      execution.task.id !== lease.taskId ||
      execution.task.threadId !== execution.thread.id ||
      execution.task.projectId !== execution.project.id ||
      !execution.project.cloud ||
      execution.thread.projectId !== execution.project.id ||
      execution.task.ownerAgentId !== execution.profile.id ||
      execution.thread.agentId !== execution.profile.id ||
      execution.profile.definitionId !== execution.definition.id ||
      lease.actor.deviceId !== this.hello.runnerId ||
      lease.actor.surface !== "runner" ||
      lease.actor.userId !== execution.task.createdBy.id ||
      lease.launchManifest.threadId !== execution.thread.id ||
      lease.launchManifest.taskId !== lease.taskId ||
      lease.launchManifest.projectId !== execution.project.id ||
      lease.launchManifest.profileId !== execution.profile.id ||
      lease.launchManifest.taskRevision !== execution.task.revision ||
      (this.hello.kind === "mac"
        ? this.hello.acceptTasks !== true || execution.task.location !== "mac"
        : this.options.taskId !== lease.taskId || execution.task.location !== "sandbox")
    )
      throw new Error("runner_lease_refused");
    const cursor = session.cursors.get(lease.taskId);
    if (cursor === undefined) throw new Error("runner_cursor_required");
    let task = this.tasks.get(lease.taskId);
    if (task) {
      if (
        task.lease.leaseId !== lease.leaseId ||
        task.lease.launchManifest.threadId !== lease.launchManifest.threadId ||
        task.lease.launchManifest.projectId !== lease.launchManifest.projectId ||
        task.lease.actor.userId !== lease.actor.userId
      )
        throw new Error("runner_lease_changed");
      await task.runtime?.update(lease);
      task.lease = lease;
    } else {
      const outbox = new RunnerOutbox({
        directory: this.options.outboxDirectory,
        binding: {
          orgId: this.options.orgId,
          taskId: lease.taskId,
          threadId: execution.thread.id,
          leaseId: lease.leaseId,
        },
        guard: this.options.guard,
      });
      outbox.reconcile(cursor);
      task = { lease, outbox, sent: cursor, ready: false };
      this.tasks.set(lease.taskId, task);
      session.initialized.add(lease.taskId);
      this.pump(session, task);
      try {
        task.runtime = await this.options.task(
          lease,
          outbox,
          () => this.publish(lease.taskId),
          this.lifetime.signal,
        );
      } catch (error) {
        this.tasks.delete(lease.taskId);
        outbox.close();
        throw error;
      }
    }
    this.pump(session, task);
    if (this.session) this.heartbeat(this.session);
  }
  private heartbeat(session: Session) {
    this.request(session, "runner.heartbeat", {
      runnerId: this.hello.runnerId,
      leaseIds: [...this.tasks.values()]
        .filter((task) => {
          task.ready = this.ready(task);
          return task.ready;
        })
        .map(({ lease }) => lease.leaseId),
      at: new Date().toISOString(),
    });
  }
  private ready(task: TaskEntry) {
    try {
      return task.runtime !== undefined && (task.runtime.ready?.() ?? true);
    } catch {
      return false;
    }
  }
  private pump(session: Session, task: TaskEntry) {
    if (!session.initialized.has(task.lease.taskId)) return;
    const available = Math.max(0, 8 - (task.sent - task.outbox.lastAck));
    if (!available) return;
    for (const frame of task.outbox.pending(task.sent, available)) {
      if (!this.request(session, "runner.event", frame)) return;
      task.sent = frame.runnerSeq;
    }
  }
  publish(taskId: string) {
    const task = this.tasks.get(taskId);
    if (this.session && task) {
      this.pump(this.session, task);
      if (task.ready !== this.ready(task)) this.heartbeat(this.session);
    }
  }
  call(
    method: "mac.status.request",
    request: MacStatusRequest,
    signal: AbortSignal,
  ): Promise<MacStatusResult>;
  call(
    method: "mac.exec.request",
    request: MacExecRequest,
    signal: AbortSignal,
  ): Promise<MacExecProgress>;
  call(
    method: "mac.status.request" | "mac.exec.request",
    request: MacStatusRequest | MacExecRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.stopped || this.hello.kind !== "sandbox" || request.taskId !== this.options.taskId)
      return Promise.reject(new Error("runner_call_unavailable"));
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    return method === "mac.status.request"
      ? this.calls.call(method, parse(MacStatusRequestSchema, request), combined)
      : this.calls.call(method, parse(MacExecRequestSchema, request), combined);
  }
  /** Put all observations committed before this call ahead of a dependent tool request. */
  async flush(taskId: string, signal: AbortSignal) {
    if (this.hello.kind !== "sandbox" || taskId !== this.options.taskId)
      throw new Error("runner_call_unavailable");
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("runner_call_unavailable");
    const target = task.outbox.nextSequence - 1;
    this.publish(taskId);
    while (task.outbox.lastAck < target) {
      if (this.stopped || signal.aborted) throw new Error("runner_call_unavailable");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (this.stopped || signal.aborted) throw new Error("runner_call_unavailable");
  }
  close(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    this.calls.close();
    this.controller?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryResolve?.();
    this.session?.socket.terminate();
    this.closing ??= (async () => {
      await this.loop;
      await this.chain;
      await Promise.allSettled([...this.bridgeJobs.values()].map((job) => job.work));
      await Promise.allSettled([...this.statusJobs]);
      const cleanup = await Promise.allSettled(
        [...this.tasks.values()].map((task) => task.runtime?.close()),
      );
      for (const task of this.tasks.values()) task.outbox.close();
      this.tasks.clear();
      if (cleanup.some((result) => result.status === "rejected"))
        throw new Error("runner_cleanup_required");
    })();
    return this.closing;
  }
}
