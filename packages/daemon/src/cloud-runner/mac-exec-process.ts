import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Static } from "@sinclair/typebox";
import type { MacExecChunkSchema, MacExecResult } from "@zoltbot/runner-protocol";
import type { MacExecution, MacExecutionOptions } from "./mac-exec.js";

type Chunk = Static<typeof MacExecChunkSchema>;
export interface MacProcessOptions {
  directory: string;
  mac: string;
  /** The Mac host supplies its environment. Tests must supply an isolated HOME/ZDOTDIR. */
  environment: NodeJS.ProcessEnv;
  /** Alternate POSIX shell for headless tests; production uses /bin/zsh. */
  shell?: string;
  /** Fast local delivery only. The durable chunk log is authoritative during a disconnect. */
  chunk?(chunk: Chunk): void;
}
const stdoutLimit = 256 * 1024,
  stderrLimit = 64 * 1024;
function tail(previous: Buffer, data: Buffer, limit: number) {
  const joined = Buffer.concat([previous, data]);
  let start = Math.max(0, joined.length - limit);
  while (start < joined.length && ((joined[start] ?? 0) & 0xc0) === 0x80) start++;
  return joined.subarray(start);
}
const watcher =
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &\nexec \"$@\" 3<&-";
function logFile(options: MacProcessOptions, input: MacExecution) {
  if (!path.isAbsolute(options.directory)) throw new Error();
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(options.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  chmodSync(options.directory, 0o700);
  const id = createHash("sha256")
    .update(JSON.stringify([input.taskId, input.requestId]))
    .digest("hex");
  return openSync(
    path.join(options.directory, `${id}.jsonl`),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
}

/** Process side effects only. Call through MacExecutionHost after its durable approval claim. */
export function macCommandProcess(options: MacProcessOptions): MacExecutionOptions["execute"] {
  return async (input, signal) => {
    if (signal.aborted) throw new Error("mac_exec_unavailable");
    if (
      process.platform === "win32" ||
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > 3600 ||
      !path.isAbsolute(input.cwd) ||
      !path.isAbsolute(options.environment?.HOME ?? "") ||
      !path.isAbsolute(options.shell ?? "/bin/zsh") ||
      !input.command ||
      input.command.length > 16000 ||
      input.command.includes("\0") ||
      Buffer.byteLength(input.stdin) > 65536
    )
      throw new Error("mac_exec_unavailable");
    let file: number;
    try {
      file = logFile(options, input);
    } catch {
      throw new Error("mac_exec_unavailable");
    }
    const started = performance.now();
    let result: MacExecResult | undefined,
      fault = false;
    try {
      result = await new Promise<MacExecResult>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(
            "/bin/sh",
            ["-c", watcher, "zoltbot-mac-exec", options.shell ?? "/bin/zsh", "-lc", input.command],
            {
              cwd: input.cwd,
              env: { ...options.environment },
              detached: true,
              stdio: ["pipe", "pipe", "pipe", "pipe"],
            },
          );
        } catch {
          reject(new Error("mac_exec_unavailable"));
          return;
        }
        let stdout = Buffer.alloc(0),
          stderr = Buffer.alloc(0),
          stdoutBytes = 0,
          stderrBytes = 0,
          seq = 0;
        let timeout = false,
          failed = false;
        const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
        const kill = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
        };
        const append = (stream: "stdout" | "stderr", data: string) => {
          if (!data) return;
          const encoded = Buffer.from(data);
          if (stream === "stdout") {
            stdoutBytes += encoded.length;
            stdout = tail(stdout, encoded, stdoutLimit);
          } else {
            stderrBytes += encoded.length;
            stderr = tail(stderr, encoded, stderrLimit);
          }
          const frame: Chunk = {
            requestId: input.requestId,
            taskId: input.taskId,
            chunkSeq: ++seq,
            stream,
            data,
          };
          try {
            const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
            let offset = 0;
            while (offset < bytes.length) {
              const written = writeSync(file, bytes, offset);
              if (!written) throw new Error();
              offset += written;
            }
            fsyncSync(file);
            // A network outage cannot cancel an already approved local command.
            try {
              void Promise.resolve(options.chunk?.(frame)).catch(() => {});
            } catch {}
          } catch {
            failed = true;
            kill();
          }
        };
        const receive = (stream: "stdout" | "stderr", data: Buffer) => {
          append(stream, decoders[stream].write(data));
        };
        const abort = () => kill();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const timer = setTimeout(() => {
          timeout = true;
          kill();
        }, input.timeoutSeconds * 1000);
        child.stdout?.on("data", (data: Buffer) => receive("stdout", data));
        child.stderr?.on("data", (data: Buffer) => receive("stderr", data));
        child.stdin?.on("error", () => {});
        child.stdin?.end(input.stdin, "utf8");
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        };
        child.once("exit", () => {
          kill();
          (child.stdio[3] as NodeJS.ReadableStream & { destroy?(): void })?.destroy?.();
        });
        child.once("error", () => {
          failed = true;
          finish();
          kill();
        });
        child.once("close", (code) => {
          finish();
          append("stdout", decoders.stdout.end());
          append("stderr", decoders.stderr.end());
          if (failed || signal.aborted) {
            reject(new Error("mac_exec_unavailable"));
            return;
          }
          resolve({
            requestId: input.requestId,
            taskId: input.taskId,
            exitCode: timeout ? 124 : (code ?? 128),
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            truncated: stdoutBytes > stdoutLimit || stderrBytes > stderrLimit,
            durationMs: Math.max(0, Math.round(performance.now() - started)),
            mac: options.mac,
          });
        });
      });
    } catch {
      fault = true;
    }
    try {
      fsyncSync(file);
    } catch {
      fault = true;
    }
    try {
      closeSync(file);
    } catch {
      fault = true;
    }
    if (fault || !result) throw new Error("mac_exec_unavailable");
    return result;
  };
}
