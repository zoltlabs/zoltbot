import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeLaunch, ClaudeTransport } from "./host.js";

/**
 * Presents a daemon supervised transport as the process the Agent SDK drives. The SDK expects
 * its spawn function to return at once, so stdio is buffered until the host has connected.
 * The launch keeps the definition's command and leading arguments; the SDK supplies the flags.
 */
export class HostProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  /** Why the host could not connect, so the session can report it instead of a closed stream. */
  failure: unknown;
  private transport: ClaudeTransport | undefined;
  private ended!: () => void;
  /** Settles once the native process has exited or never started. */
  readonly exited = new Promise<void>((resolve) => {
    this.ended = resolve;
  });
  constructor(
    connect: (launch: ClaudeLaunch) => Promise<ClaudeTransport>,
    base: Omit<ClaudeLaunch, "args" | "env">,
    prefix: string[],
    spawn: SpawnOptions,
  ) {
    super();
    const env = Object.fromEntries(
      Object.entries(spawn.env).filter((entry): entry is [string, string] => entry[1] != null),
    );
    spawn.signal?.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
    void connect({ ...base, args: [...prefix, ...spawn.args], env }).then(
      (transport) => {
        this.transport = transport;
        void transport.closed.then(() => this.exit());
        if (this.killed) {
          void transport.close().catch(() => {});
          return;
        }
        void (Readable.toWeb(this.stdin) as unknown as ReadableStream<Uint8Array>)
          .pipeTo(transport.output)
          .catch(() => {});
        Readable.fromWeb(transport.input as never)
          .on("error", () => this.stdout.end())
          .pipe(this.stdout);
      },
      (error: unknown) => {
        this.failure = error;
        this.emit("error", error instanceof Error ? error : new Error("process_spawn_failed"));
        this.exit();
      },
    );
  }
  kill(_signal: NodeJS.Signals) {
    if (this.exitCode !== null) return false;
    this.killed = true;
    void this.transport?.close().catch(() => {});
    return true;
  }
  private exit() {
    if (this.exitCode !== null) return;
    this.exitCode = this.killed ? 0 : 1;
    this.stdout.end();
    this.emit("exit", this.exitCode, null);
    this.ended();
  }
}
