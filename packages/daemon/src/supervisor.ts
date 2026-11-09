import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "./logging.js";

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  backoffMs?: number;
  killGraceMs?: number;
  /** The desktop daemon outlives its UI; native providers must remain parent-owned. */
  surviveParentExit?: boolean;
  frameFile: string;
  frameLimitBytes?: number;
  maxLineBytes?: number;
}
export function childEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    // macOS CLIs such as Claude find their Keychain login by account name.
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
/**
 * Runs the provider in its own process group next to a watcher, as T3 Code does. The watcher
 * blocks reading fd 3, a pipe only the daemon holds the other end of. When the daemon exits for
 * any reason, including a crash or SIGKILL, the pipe closes and the watcher stops the whole group:
 * the provider and every MCP server or tool it started. The provider itself runs without fd 3.
 */
const groupWatch = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");
function launch(command: string, args: string[]) {
  return process.platform === "win32"
    ? { command, args, watched: false }
    : {
        command: "/bin/sh",
        args: ["-c", groupWatch, "zoltbot-native", command, ...args],
        watched: true,
      };
}
function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("request_timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
export class Supervisor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private closePromise: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<(error: Error) => void>();
  private failures = 0;
  private startedAt = 0;
  starts = 0;
  status: "idle" | "running" | "restarting" | "needs_attention" | "closed" = "idle";
  readonly stderrTail: string[] = [];
  readonly frameFile: string;
  constructor(
    private readonly options: ProcessOptions,
    private readonly logger: Logger,
  ) {
    super();
    this.frameFile = options.frameFile;
    mkdirSync(path.dirname(this.frameFile), { recursive: true, mode: 0o700 });
  }
  get pid() {
    return this.child?.pid;
  }
  start() {
    if (this.stopping || this.child || this.failures >= 3) return;
    this.starts++;
    this.startedAt = Date.now();
    const target = this.options.surviveParentExit
      ? { command: this.options.command, args: this.options.args, watched: false }
      : launch(this.options.command, this.options.args);
    const child = spawn(target.command, target.args, {
      cwd: this.options.cwd,
      env: childEnvironment(this.options.env),
      stdio: target.watched ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      detached: true,
    }) as unknown as ChildProcessWithoutNullStreams;
    this.child = child;
    // Once the provider exits, stop what it left in its group and release the watcher.
    child.once("exit", () => {
      this.kill("SIGKILL", child);
      (child.stdio[3] as (NodeJS.ReadableStream & { destroy?(): void }) | undefined)?.destroy?.();
    });
    this.status = "running";
    child.stdin.on("error", () => {
      if (this.stopping) return;
      this.logger.write("warn", "Provider input closed");
      this.emit("fault", "provider_input_closed");
      this.kill("SIGTERM");
    });
    this.drain(child.stdout, "stdout");
    this.drain(child.stderr, "stderr");
    child.once("error", (error) => {
      this.logger.write("error", "Provider launch failed", { message: error.message });
      this.emit("fault", this.logger.redactor.text(error.message));
    });
    child.once("close", (code, signal) => {
      this.child = undefined;
      for (const reject of this.pending) reject(new Error("process_died"));
      this.pending.clear();
      this.emit("exit", { code, signal });
      if (this.stopping) {
        this.status = "closed";
        return;
      }
      this.failures = Date.now() - this.startedAt < 120000 ? this.failures + 1 : 1;
      if (this.failures >= 3) {
        this.status = "needs_attention";
        this.emit("attention", this.stderrTail);
        return;
      }
      this.status = "restarting";
      this.restartTimer = setTimeout(
        () => this.start(),
        (this.options.backoffMs ?? 500) * 2 ** (this.failures - 1),
      );
    });
  }
  private drain(stream: NodeJS.ReadableStream, direction: "stdout" | "stderr") {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const consume = (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n"),
          line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (Buffer.byteLength(line) > (this.options.maxLineBytes ?? 1048576)) {
          this.emit("fault", "frame_too_large");
          this.kill("SIGTERM");
          return;
        }
        const redacted = this.logger.redactor.hidesFrames
          ? "[private runtime output omitted]"
          : this.logger.redactor.text(line);
        this.frame(direction, line);
        if (direction === "stderr") {
          this.stderrTail.push(redacted.slice(-4000));
          if (this.stderrTail.length > 50) this.stderrTail.shift();
        }
        this.emit(
          direction,
          direction === "stderr" && this.logger.redactor.hidesFrames ? redacted : line,
        );
      }
      if (Buffer.byteLength(buffer) > (this.options.maxLineBytes ?? 1048576)) {
        buffer = "";
        this.emit("fault", "frame_too_large");
        this.kill("SIGTERM");
      }
    };
    stream.on("data", (chunk: Buffer) => consume(decoder.write(chunk)));
    stream.on("end", () => {
      consume(decoder.end());
      if (buffer) consume("\n");
    });
  }
  private frame(direction: string, line: string) {
    let safe = this.logger.redactor.text(line);
    if (this.logger.redactor.hidesFrames)
      safe = JSON.stringify({
        redacted: true,
        reason: "private_answer",
        payload: "[redacted]",
        bytes: Buffer.byteLength(line),
      });
    else {
      try {
        safe = JSON.stringify(this.logger.redactor.value(JSON.parse(line)));
      } catch {}
    }
    const record = `${JSON.stringify({ at: new Date().toISOString(), direction, line: safe })}\n`;
    const cap = this.options.frameLimitBytes ?? 2_000_000;
    if (Buffer.byteLength(record) > cap) return;
    let size = 0;
    try {
      size = statSync(this.frameFile).size;
    } catch {}
    if (size + Buffer.byteLength(record) > cap) writeFileSync(this.frameFile, "", { mode: 0o600 });
    appendFileSync(this.frameFile, record, { mode: 0o600 });
  }
  write(line: string) {
    if (!this.child || this.status !== "running") throw new Error("provider_not_running");
    this.frame("stdin", line);
    return this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }
  pauseOutput() {
    this.child?.stdout.pause();
  }
  resumeOutput() {
    this.child?.stdout.resume();
  }
  async writeAsync(line: string) {
    const child = this.child;
    if (!child || this.status !== "running") throw new Error("provider_not_running");
    this.frame("stdin", line);
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  track<T>(promise: Promise<T>): Promise<T> {
    let rejectPending: (error: Error) => void = () => {};
    const death = new Promise<never>((_, reject) => {
      rejectPending = reject;
      this.pending.add(reject);
    });
    return Promise.race([promise, death]).finally(() => this.pending.delete(rejectPending));
  }
  async guard<T>(promise: Promise<T>, ms: number, probe: () => Promise<unknown>): Promise<T> {
    try {
      return await timeout(this.track(promise), ms);
    } catch (error) {
      if (error instanceof Error && error.message === "request_timeout") {
        try {
          await timeout(probe(), ms);
        } catch {
          this.kill("SIGTERM");
        }
      }
      throw error;
    }
  }
  private kill(signal: NodeJS.Signals, child = this.child) {
    const pid = child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child?.kill(signal);
    }
  }
  close() {
    this.closePromise ??= this.stop();
    return this.closePromise;
  }
  private async stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.restartTimer);
    for (const reject of this.pending) reject(new Error("process_died"));
    this.pending.clear();
    const child = this.child;
    if (child) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.stdin.end();
      this.kill("SIGTERM");
      try {
        await timeout(closed, this.options.killGraceMs ?? 3000);
      } catch {
        this.kill("SIGKILL");
        await closed;
      }
    }
    this.status = "closed";
  }
}
