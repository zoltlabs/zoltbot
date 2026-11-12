import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";

export function managedGit(
  cwd: string,
  args: readonly string[],
  token: string | undefined,
  signal: AbortSignal,
  maxBytes = 65536,
  raw = false,
  input?: Buffer,
): Promise<string> {
  const config: Record<string, string> = {
    "credential.helper": "",
    "user.name": "Zolt Labs",
    "user.email": "zolt@zoltbot.ai",
    "i18n.commitEncoding": "UTF-8",
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
    GIT_PAGER: "",
    GIT_EDITOR: "/usr/bin/false",
    GIT_SEQUENCE_EDITOR: "/usr/bin/false",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
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
    child.once("exit", () => {
      if (watched && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      (child.stdio[3] as NodeJS.ReadableStream & { destroy?(): void })?.destroy?.();
    });
    const output: Buffer[] = [];
    let bytes = 0,
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
    child.stdin.on("error", stop);
    child.stdin.end(input);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > maxBytes) stop();
      else output.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > maxBytes) stop();
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
      else {
        const text = Buffer.concat(output).toString("utf8");
        resolve(raw ? text : text.trimEnd());
      }
    });
  });
}

export async function assertManagedGitConfiguration(cwd: string, signal: AbortSignal) {
  let shallow = false;
  try {
    await lstat(path.join(cwd, ".git", "shallow"));
    shallow = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (shallow) throw new Error();
  const keys = (
    await managedGit(cwd, ["config", "--local", "--name-only", "--list"], undefined, signal)
  ).split("\n");
  // Local networking/filter configuration cannot redirect the credential-bearing operation.
  if (
    keys.some(
      (key) =>
        (/^remote\./i.test(key) &&
          !["remote.origin.url", "remote.origin.fetch"].includes(key.toLowerCase())) ||
        /^(?:https?\.|url\.|include(?:if)?\.|credential\.|filter\.|protocol\.|core\.(?:sshcommand|gitproxy)$|extensions\.worktreeconfig$)/i.test(
          key,
        ),
    )
  )
    throw new Error();
}
