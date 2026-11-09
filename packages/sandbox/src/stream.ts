import type { ExecChunk, ExecExit, ExecProcess } from "./interface.js";

/** Buffers output until it is read, so a late consumer still sees every chunk. */
export class ExecChannel implements ExecProcess {
  readonly exit: Promise<ExecExit>;
  private readonly chunks: ExecChunk[] = [];
  private waiting: (() => void) | undefined;
  private ended = false;
  private failure: unknown;
  private settle!: (exit: ExecExit) => void;
  private fail!: (error: unknown) => void;

  constructor(private readonly onKill: () => Promise<void>) {
    this.exit = new Promise<ExecExit>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    // Callers may only iterate; a rejected exit must not become an unhandled rejection.
    this.exit.catch(() => undefined);
  }

  push(stream: ExecChunk["stream"], data: string) {
    if (this.ended || !data) return;
    this.chunks.push({ stream, data });
    this.wakeReader();
  }

  end(exit: ExecExit) {
    if (this.ended) return;
    this.ended = true;
    this.settle(exit);
    this.wakeReader();
  }

  error(error: unknown) {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.fail(error);
    this.wakeReader();
  }

  kill() {
    return this.onKill();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ExecChunk> {
    for (;;) {
      const next = this.chunks.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  private wakeReader() {
    const resolve = this.waiting;
    this.waiting = undefined;
    resolve?.();
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

/** Reads a process to the end. */
export async function collect(process: ExecProcess): Promise<ExecResult> {
  let stdout = "";
  let stderr = "";
  for await (const chunk of process) {
    if (chunk.stream === "stdout") stdout += chunk.data;
    else stderr += chunk.data;
  }
  const exit = await process.exit;
  return { stdout, stderr, code: exit.code, ...(exit.killed ? { killed: true } : {}) };
}

/** Quotes argv for targets whose exec API takes one shell command line. */
export function shellJoin(argv: string[]): string {
  return argv
    .map((arg) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

export function resolvePath(workdir: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${workdir.replace(/\/$/, "")}/${path}`;
}
