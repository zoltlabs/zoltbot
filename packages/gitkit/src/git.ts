import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

export async function git(cwd: string, args: readonly string[], write = false): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [...(write ? [] : ["--no-optional-locks", "-c", "core.fsmonitor=false"]), ...args],
      {
        cwd,
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    let bytes = 0,
      stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(stop, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop();
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop();
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`git_failed: ${args[0]}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped || code !== 0) reject(new Error(`git_failed: ${args[0]}`));
      else resolve(Buffer.concat(output).toString("utf8").trimEnd());
    });
  });
}
export interface Repository {
  root: string;
  commonDir: string;
  head: string;
}
export async function repository(folder: string): Promise<Repository> {
  const root = await realpath(folder);
  const top = await realpath(await git(root, ["rev-parse", "--show-toplevel"]));
  if (root !== top) throw new Error("repository_root_required");
  const commonDir = await realpath(
    path.resolve(root, await git(root, ["rev-parse", "--git-common-dir"])),
  );
  if (
    (await git(root, ["ls-files", "--stage", "-z"]))
      .split("\0")
      .some((line) => line.startsWith("160000 "))
  )
    throw new Error("submodules_unsupported");
  return { root, commonDir, head: await commit(root, "HEAD") };
}
export async function commit(root: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) throw new Error("invalid_ref");
  const oid = await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("invalid_commit");
  return oid;
}
const queues = new Map<string, Promise<unknown>>();
export async function repositoryLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
export async function clean(root: string): Promise<void> {
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    const artifacts = status
      .split("\n")
      .filter((line) => line.includes(".zoltbot/"))
      .slice(0, 10)
      .map((line) => line.slice(3, 163));
    throw new Error(
      artifacts.length ? `destination_dirty: ${artifacts.join(", ")}` : "destination_dirty",
    );
  }
}
