import { randomUUID } from "node:crypto";
import { parse } from "@zoltbot/protocol";
import {
  type MacExecRequest,
  MacExecRequestSchema,
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
import { RunnerOutbox } from "./outbox.js";

export interface RunnerCredentials {
  url: string;
  token: string;
  expiresAt: number;
}
export interface ConnectedTask {
  update(lease: RunnerLease): Promise<void>;
  command(command: RunnerCommand, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
interface TaskEntry {
  lease: RunnerLease;
  outbox: RunnerOutbox;
  runtime?: ConnectedTask;
  sent: number;
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
  status?(code: string): void;
  /** Localhost-only test servers; production connections always use TLS. */
  allowLoopback?: boolean;
  retryBaseMs?: number;
}

/** Transport only: execution and signed approvals belong to the task/bridge hosts. */
export class RunnerConnection {
  private readonly hello: RunnerHello;
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly lifetime = new AbortController();
  private session: Session | undefined;
  private chain = Promise.resolve();
  private stopped = false;
  private loop: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryResolve: (() => void) | undefined;
  constructor(private readonly options: RunnerConnectionOptions) {
    this.hello = parse(RunnerHelloSchema, structuredClone(options.hello));
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
      } catch {
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
    return new Promise<void>((resolve) => {
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
      socket.on("error", () => {
        this.status("runner_connection_unavailable");
        socket.terminate();
      });
      socket.on("close", () => {
        clearTimeout(helloDeadline);
        clearInterval(heartbeat);
        clearTimeout(renewal);
        if (this.session === session) this.session = undefined;
        resolve();
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
      if ("error" in message) throw new Error("runner_request_refused");
      if (message.id === "hello") {
        this.status("runner_connected");
        this.heartbeat(session);
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
    if (!["runner.lease", "runner.command", "mac.exec.request"].includes(message.method))
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
          } else {
            if (this.hello.kind !== "mac" || !this.options.macExec)
              throw new Error("runner_bridge_unavailable");
            result = await this.options.macExec(
              parse(MacExecRequestSchema, message.params),
              this.lifetime.signal,
            );
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
      task = { lease, outbox, sent: cursor };
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
        .filter((task) => task.runtime !== undefined)
        .map(({ lease }) => lease.leaseId),
      at: new Date().toISOString(),
    });
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
    if (this.session && task) this.pump(this.session, task);
  }
  async close() {
    this.stopped = true;
    this.lifetime.abort();
    this.controller?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryResolve?.();
    this.session?.socket.terminate();
    await this.loop;
    await this.chain;
    await Promise.allSettled([...this.tasks.values()].map((task) => task.runtime?.close()));
    for (const task of this.tasks.values()) task.outbox.close();
    this.tasks.clear();
  }
}
