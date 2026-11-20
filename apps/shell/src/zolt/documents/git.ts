import { execFile } from "node:child_process";
import type { DocumentGitState, DocumentsGit } from "../../shared/documents";

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd` without prompts, with a time limit, and rejects with git's own message. */
export function git(cwd: string, args: string[], timeout = 15_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new Error(
              missing ? "Git isn't installed on this Mac." : stderr.trim() || error.message,
            ),
          );
        } else resolve({ stdout, stderr });
      },
    );
  });
}

/** The repository's top folder, or null when `folder` isn't in a git repository. */
export async function gitTop(folder: string): Promise<string | null> {
  try {
    return (await git(folder, ["rev-parse", "--show-toplevel"])).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Git's state for each changed file, keyed by its path relative to `folder`. */
export async function gitStatus(folder: string): Promise<Map<string, DocumentGitState>> {
  // Porcelain paths are relative to the repository's top; the prefix makes them relative to folder.
  const prefix = (await git(folder, ["rev-parse", "--show-prefix"])).stdout.trim();
  const { stdout } = await git(folder, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
  ]);
  const states = new Map<string, DocumentGitState>();
  const entries = stdout.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const full = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") index++;
    if (!full.startsWith(prefix)) continue;
    const path = full.slice(prefix.length);
    states.set(
      path,
      code === "??"
        ? "untracked"
        : code.includes("D")
          ? "deleted"
          : code[0] === "R"
            ? "renamed"
            : code[0] === "A"
              ? "added"
              : "modified",
    );
  }
  return states;
}

export async function gitSummary(folder: string, changed: number): Promise<DocumentsGit | null> {
  try {
    const branch = (await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const current = branch === "HEAD" ? null : branch || null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    try {
      upstream = (
        await git(folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
      ).stdout.trim();
      const counts = (
        await git(folder, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])
      ).stdout
        .trim()
        .split(/\s+/)
        .map(Number);
      behind = counts[0] || 0;
      ahead = counts[1] || 0;
    } catch {}
    let defaultBranch: string | null = null;
    try {
      defaultBranch = (
        await git(folder, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      ).stdout
        .trim()
        .replace(/^origin\//, "");
    } catch {}
    let remote: string | null = null;
    try {
      remote = (await git(folder, ["remote", "get-url", "origin"])).stdout.trim();
    } catch {}
    return {
      branch: current,
      defaultBranch,
      upstream,
      ahead,
      behind,
      changed,
      pullRequestUrl: pullRequestUrl(remote, current, defaultBranch),
    };
  } catch {
    return null;
  }
}

/** GitHub's page for opening a pull request from `branch`, or null when it isn't on GitHub. */
export function pullRequestUrl(
  remote: string | null,
  branch: string | null,
  defaultBranch: string | null,
): string | null {
  if (!remote || !branch || branch === (defaultBranch ?? "main")) return null;
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}/compare/${encodeURIComponent(branch)}?expand=1`;
}

/** The file as of the last commit, or null when it has never been committed. */
export async function committedText(folder: string, path: string): Promise<string | null> {
  try {
    return (await git(folder, ["show", `HEAD:./${path}`])).stdout;
  } catch {
    return null;
  }
}

export interface FileCommit {
  sha: string;
  author: string;
  at: string;
  message: string;
}

export async function fileLog(folder: string, path: string, limit = 30): Promise<FileCommit[]> {
  try {
    const { stdout } = await git(folder, [
      "log",
      `-n${limit}`,
      "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
      "--",
      path,
    ]);
    return stdout
      .split("\x1e")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, author, at, message] = line.split("\x1f");
        return { sha, author, at, message };
      });
  } catch {
    return [];
  }
}

export async function textAtCommit(folder: string, sha: string, path: string): Promise<string> {
  if (!/^[a-f0-9]{7,64}$/.test(sha)) throw new Error("That commit isn't available.");
  try {
    return (await git(folder, ["show", `${sha}:./${path}`])).stdout;
  } catch {
    throw new Error("This file isn't in that commit.");
  }
}
