import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface WorkerSetupOptions {
  directory: string;
  orgId: string;
  taskId: string;
  cwd: string;
  baseCommit: string;
  script: string;
  environment: Record<string, string>;
  guard(value: unknown): void;
  timeoutMs?: number;
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeState(directory: string, value: unknown) {
  const temporary = path.join(directory, `setup-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(directory, "setup.json"));
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function readState(directory: string): Promise<Record<string, unknown> | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path.join(directory, "setup.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw new Error();
    const bytes = Buffer.alloc(16385),
      read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 16384) throw new Error();
    const value: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "baseCommit,cwd,orgId,scriptHash,state,taskId,version"
    )
      throw new Error("worker_setup_unavailable");
    const row = value as Record<string, unknown>;
    if (!["started", "ready", "failed"].includes(String(row.state)))
      throw new Error("worker_setup_unavailable");
    return row;
  } finally {
    await handle.close();
  }
}
function execute(options: WorkerSetupOptions, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("worker_setup_canceled"));
      return;
    }
    const watched = process.platform !== "win32";
    const watch =
      "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &\nexec \"$@\" 3<&-";
    const child = spawn(
      watched ? "/bin/sh" : "bash",
      watched
        ? ["-c", watch, "zoltbot-setup", "bash", "-lc", options.script]
        : ["-lc", options.script],
      {
        cwd: options.cwd,
        env: { ...options.environment, CI: "1", GIT_TERMINAL_PROMPT: "0" },
        detached: watched,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    let fault: string | undefined,
      bytes = 0;
    const kill = () => {
      try {
        if (watched && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const abort = () => {
      fault = "worker_setup_canceled";
      kill();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      fault = "worker_setup_timeout";
      kill();
    }, options.timeoutMs ?? 900000);
    const output = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        fault = "worker_setup_output_limit";
        kill();
      }
    };
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    child.once("exit", () => {
      kill();
      (child.stdio[3] as NodeJS.ReadableStream & { destroy?(): void })?.destroy?.();
    });
    child.once("error", () => {
      finish();
      reject(new Error("worker_setup_failed"));
    });
    child.once("close", (code) => {
      finish();
      if (fault || code !== 0) reject(new Error(fault ?? "worker_setup_failed"));
      else resolve();
    });
  });
}

/** Caller holds its CloudTaskCache owner lock. A crash cannot silently rerun setup side effects. */
export async function prepareWorkerRepository(options: WorkerSetupOptions, signal: AbortSignal) {
  try {
    if (
      !path.isAbsolute(options.directory) ||
      !path.isAbsolute(options.cwd) ||
      !options.orgId ||
      !options.taskId ||
      options.script.length > 64000 ||
      /\0/.test(options.script)
    )
      throw new Error("worker_setup_scope_conflict");
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 3600000)
    )
      throw new Error("worker_setup_scope_conflict");
    if (signal.aborted) throw new Error("worker_setup_canceled");
    options.guard(options.script);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(options.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("worker_setup_unavailable");
    await chmod(options.directory, 0o700);
    const directory = await realpath(options.directory),
      cwd = await realpath(options.cwd);
    const binding = {
      version: 1,
      orgId: options.orgId,
      taskId: options.taskId,
      cwd,
      baseCommit: options.baseCommit,
      scriptHash: createHash("sha256").update(options.script).digest("hex"),
    };
    const saved = await readState(directory);
    if (saved) {
      if (Object.entries(binding).some(([key, value]) => saved[key] !== value))
        throw new Error("worker_setup_scope_conflict");
      if (saved.state === "ready") return;
      if (saved.state === "failed") throw new Error("worker_setup_failed");
      throw new Error("worker_setup_interrupted");
    }
    if (options.script.trim()) {
      await writeState(directory, { ...binding, state: "started" });
      try {
        await execute({ ...options, cwd }, signal);
      } catch (error) {
        await writeState(directory, { ...binding, state: "failed" });
        throw error;
      }
    }
    await writeState(directory, { ...binding, state: "ready" });
  } catch (error) {
    if (
      error instanceof Error &&
      /^worker_setup_(?:scope_conflict|unavailable|canceled|failed|interrupted|timeout|output_limit)$/.test(
        error.message,
      )
    )
      throw error;
    throw new Error("worker_setup_unavailable");
  }
}
