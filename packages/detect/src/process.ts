import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  inherited?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  input?: string;
  stopWhen?: (stdout: string) => boolean;
}
export interface RunResult {
  code: number | null;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  failure?: "not_found" | "permission_denied" | "launch_failed" | "timeout" | "output_limit";
}
export type CommandRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<RunResult>;
const allowed = new Set([
  "PATH",
  "HOME",
  // macOS CLIs such as Claude find their Keychain login by account name.
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]);
export function processEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  explicit: Record<string, string> = {},
) {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key, value]) => allowed.has(key) && typeof value === "string",
      ),
    ),
    ...explicit,
  } as Record<string, string>;
}
export const runCommand: CommandRunner = async (command, args, options) =>
  new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      size = 0;
    let failure: RunResult["failure"];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: processEnvironment(options.inherited, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = (reason: RunResult["failure"]) => {
      failure ??= reason;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? 1000);
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 5000);
    const drain = (stream: NodeJS.ReadableStream, target: "stdout" | "stderr") => {
      const decoder = new StringDecoder("utf8");
      const append = (text: string) => {
        if (target === "stdout") stdout += text;
        else stderr += text;
      };
      stream.on("data", (bytes: Buffer) => {
        const limit = options.maxOutputBytes ?? 262144;
        const available = Math.max(0, limit - size);
        size += bytes.byteLength;
        append(decoder.write(bytes.subarray(0, available)));
        if (size > limit) stop("output_limit");
        else if (target === "stdout" && options.stopWhen?.(stdout)) {
          clearTimeout(timer);
          kill("SIGTERM");
          killTimer ??= setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? 1000);
        }
      });
      stream.on("end", () => append(decoder.end()));
    };
    drain(child.stdout, "stdout");
    drain(child.stderr, "stderr");
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      failure =
        code === "ENOENT" ? "not_found" : code === "EACCES" ? "permission_denied" : "launch_failed";
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        code,
        ...(signal ? { signal } : {}),
        stdout,
        stderr,
        ...(failure ? { failure } : {}),
      });
    });
  });
