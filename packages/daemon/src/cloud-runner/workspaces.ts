import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { acquireOwnerLock } from "@zoltbot/store";

export interface ManagedWorkspaceInput {
  orgId: string;
  taskId: string;
  repository: string;
  defaultBranch: string;
}
export interface ManagedWorkspaceResult {
  cwd: string;
  baseCommit: string;
}
interface Binding extends ManagedWorkspaceInput {
  version: 1;
  stage: "prepared" | "ready";
  baseCommit: string;
}

/** Each task owns a clone. Control files live beside it, never inside an agent's worktree. */
export class ManagedWorkspaces {
  private readonly pending = new Map<string, Promise<ManagedWorkspaceResult>>();
  constructor(
    private readonly options: {
      directory: string;
      githubToken?(signal: AbortSignal): Promise<string | undefined>;
      /** A local bare repository for headless tests; production uses only github.com. */
      localRepository?(repository: string): string;
      /** A sandbox owns one task and exposes its clone as workDirectory/<repo>. */
      sandbox?: { orgId: string; taskId: string; workDirectory: string };
    },
  ) {}
  prepare(input: ManagedWorkspaceInput, signal: AbortSignal): Promise<ManagedWorkspaceResult> {
    const frozen = structuredClone(input);
    const sandbox = this.options.sandbox;
    if (
      sandbox &&
      (sandbox.orgId !== frozen.orgId ||
        sandbox.taskId !== frozen.taskId ||
        !path.isAbsolute(sandbox.workDirectory))
    )
      return Promise.reject(new Error("managed_workspace_scope_conflict"));
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(frozen.repository) ||
      frozen.repository.length > 256 ||
      frozen.repository.split("/").some((part) => [".", ".."].includes(part)) ||
      !frozen.orgId ||
      !frozen.taskId ||
      !frozen.defaultBranch ||
      frozen.defaultBranch.length > 200 ||
      frozen.defaultBranch.startsWith("-") ||
      /[\0\r\n]/.test(frozen.defaultBranch)
    )
      return Promise.reject(new Error("managed_repository_invalid"));
    const id = createHash("sha256")
      .update(JSON.stringify([frozen.orgId, frozen.taskId]))
      .digest("hex");
    const existing = this.pending.get(id);
    if (existing)
      return existing.then(async (result) =>
        this.validateBinding(frozen, result, path.join(await realpath(this.options.directory), id)),
      );
    const work = this.open(frozen, id, signal);
    this.pending.set(id, work);
    void work
      .finally(() => {
        if (this.pending.get(id) === work) this.pending.delete(id);
      })
      .catch(() => {});
    return work;
  }
  private async directory(folder: string) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("managed_workspace_unavailable");
    await chmod(folder, 0o700);
    return realpath(folder);
  }
  private remote(input: ManagedWorkspaceInput) {
    const local = this.options.localRepository?.(input.repository);
    if (local !== undefined) {
      if (!path.isAbsolute(local) || /[\0\r\n]/.test(local))
        throw new Error("managed_repository_invalid");
      return local;
    }
    return `https://github.com/${input.repository}.git`;
  }
  private async binding(file: string): Promise<Binding> {
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 16384) throw new Error("managed_workspace_unavailable");
      return JSON.parse(await fd.readFile("utf8")) as Binding;
    } finally {
      await fd.close();
    }
  }
  private async validateBinding(
    input: ManagedWorkspaceInput,
    result: ManagedWorkspaceResult,
    control: string,
  ) {
    const binding = await this.binding(path.join(control, "binding.json"));
    if (
      binding.version !== 1 ||
      Object.entries(input).some(([key, value]) => binding[key as keyof Binding] !== value)
    )
      throw new Error("managed_workspace_scope_conflict");
    return result;
  }
  private async open(
    input: ManagedWorkspaceInput,
    id: string,
    signal: AbortSignal,
  ): Promise<ManagedWorkspaceResult> {
    let temporary: string | undefined;
    let owner: ReturnType<typeof acquireOwnerLock> | undefined;
    try {
      const root = await this.directory(this.options.directory);
      const control = await this.directory(path.join(root, id));
      owner = acquireOwnerLock(path.join(control, "checkout.lock"));
      const cwd = this.options.sandbox
          ? path.join(
              await this.directory(this.options.sandbox.workDirectory),
              input.repository.split("/")[1] as string,
            )
          : path.join(control, "repo"),
        file = path.join(control, "binding.json"),
        remote = this.remote(input);
      let info: Stats | undefined;
      try {
        info = await lstat(cwd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (info) {
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("managed_workspace_unavailable");
        const gitDirectory = path.join(cwd, ".git"),
          gitInfo = await lstat(gitDirectory);
        if (gitInfo.isSymbolicLink() || !gitInfo.isDirectory())
          throw new Error("managed_workspace_changed");
        const common = await this.git(cwd, ["rev-parse", "--git-common-dir"], undefined, signal);
        if ((await realpath(path.resolve(cwd, common))) !== (await realpath(gitDirectory)))
          throw new Error("managed_workspace_changed");
        const binding = await this.binding(file);
        if (
          binding.version !== 1 ||
          !/^[a-f0-9]{40,64}$/.test(binding.baseCommit) ||
          Object.entries(input).some(([key, value]) => binding[key as keyof Binding] !== value)
        )
          throw new Error("managed_workspace_scope_conflict");
        const rootPath = await this.git(cwd, ["rev-parse", "--show-toplevel"], undefined, signal);
        if (
          (await realpath(rootPath)) !== (await realpath(cwd)) ||
          (await this.git(cwd, ["config", "--get", "remote.origin.url"], undefined, signal)) !==
            remote
        )
          throw new Error("managed_workspace_changed");
        if (binding.stage !== "ready" && binding.stage !== "prepared")
          throw new Error("managed_workspace_unavailable");
        if (binding.stage === "prepared")
          await this.writeBinding(control, { ...binding, stage: "ready" });
        return { cwd, baseCommit: binding.baseCommit };
      }
      let previous: Binding | undefined;
      try {
        previous = await this.binding(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (previous?.stage === "ready") throw new Error("managed_workspace_missing");
      if (
        previous &&
        (previous.stage !== "prepared" ||
          previous.version !== 1 ||
          !/^[a-f0-9]{40,64}$/.test(previous.baseCommit) ||
          Object.entries(input).some(([key, value]) => previous?.[key as keyof Binding] !== value))
      )
        throw new Error("managed_workspace_scope_conflict");
      if (signal.aborted) throw new Error("managed_workspace_canceled");
      const token = await this.credentials(signal);
      if (signal.aborted) throw new Error("managed_workspace_canceled");
      if (token && (token.length > 16384 || /[\0\r\n]/.test(token)))
        throw new Error("managed_credentials_invalid");
      await this.git(
        control,
        ["check-ref-format", "--branch", input.defaultBranch],
        undefined,
        signal,
      );
      temporary = path.join(control, `clone-${randomUUID()}`);
      await this.git(
        control,
        [
          "clone",
          "--no-hardlinks",
          "--single-branch",
          "--branch",
          input.defaultBranch,
          "--",
          remote,
          temporary,
        ],
        token,
        signal,
      );
      const baseCommit =
        previous?.baseCommit ??
        (await this.git(temporary, ["rev-parse", "--verify", "HEAD^{commit}"], undefined, signal));
      if (previous) {
        try {
          await this.git(
            temporary,
            ["cat-file", "-e", `${baseCommit}^{commit}`],
            undefined,
            signal,
          );
        } catch {
          await this.git(temporary, ["fetch", "--no-tags", "origin", baseCommit], token, signal);
        }
      }
      await this.git(
        temporary,
        ["switch", "-c", `zoltbot/task-${id.slice(0, 16)}`, baseCommit],
        undefined,
        signal,
      );
      if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("managed_workspace_unavailable");
      const binding: Binding = { ...input, version: 1, stage: "prepared", baseCommit };
      if (!previous) await this.writeBinding(control, binding);
      await rename(temporary, cwd);
      temporary = undefined;
      await this.writeBinding(control, { ...binding, stage: "ready" });
      return { cwd, baseCommit };
    } catch (error) {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (
        error instanceof Error &&
        [
          "managed_workspace_scope_conflict",
          "managed_workspace_changed",
          "managed_workspace_missing",
          "managed_workspace_canceled",
          "managed_credentials_invalid",
        ].includes(error.message)
      )
        throw error;
      throw new Error("managed_workspace_unavailable");
    } finally {
      owner?.release();
    }
  }
  private async credentials(signal: AbortSignal) {
    let abort = () => {};
    try {
      return await Promise.race([
        this.options.githubToken?.(signal),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("managed_workspace_canceled"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async writeBinding(control: string, binding: Binding) {
    const staging = path.join(control, `binding-${randomUUID()}.tmp`);
    const descriptor = await open(
      staging,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await descriptor.writeFile(JSON.stringify(binding));
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await rename(staging, path.join(control, "binding.json"));
    const directory = await open(control, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private git(
    cwd: string,
    args: readonly string[],
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const config: Record<string, string> = {
      "credential.helper": "",
      "core.hooksPath": "/dev/null",
      "core.fsmonitor": "false",
      "init.templateDir": "",
      "http.followRedirects": "false",
      ...(token
        ? {
            "http.https://github.com/.extraheader": `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          }
        : {}),
    };
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      GIT_CONFIG_COUNT: String(Object.keys(config).length),
    };
    Object.entries(config).forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("managed_workspace_canceled"));
        return;
      }
      // fd 3 belongs only to the parent. A crash closes it and stops Git's group,
      // including credential or transport children; the Git process cannot keep it alive.
      const watched = process.platform !== "win32";
      const watch =
        "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &\nexec \"$@\" 3<&-";
      const child = spawn(
        watched ? "/bin/sh" : "git",
        watched ? ["-c", watch, "zoltbot-git", "git", ...args] : [...args],
        { cwd, env, detached: watched, stdio: ["pipe", "pipe", "pipe", "pipe"] },
      );
      child.stdin.end();
      child.once("exit", () => {
        if (watched && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        (child.stdio[3] as NodeJS.ReadableStream & { destroy?(): void })?.destroy?.();
      });
      let bytes = 0,
        output = "",
        stopped = false;
      const stop = () => {
        stopped = true;
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const timer = setTimeout(stop, 120000);
      child.stdout.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 65536) stop();
        else output += data.toString("utf8");
      });
      child.stderr.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 65536) stop();
      });
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      };
      child.once("error", () => {
        finish();
        reject(new Error("managed_workspace_unavailable"));
      });
      child.once("close", (code) => {
        finish();
        if (signal.aborted) reject(new Error("managed_workspace_canceled"));
        else if (stopped || code !== 0) reject(new Error("managed_workspace_unavailable"));
        else resolve(output.trimEnd());
      });
    });
  }
}
