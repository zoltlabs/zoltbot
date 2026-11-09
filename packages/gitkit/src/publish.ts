import { createHash } from "node:crypto";
import { githubRepository, remoteRepository } from "../../github/src/client.js";
import { git } from "./git.js";
import { executionFingerprint } from "./hooks.js";

export const publishHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function githubRemotes(cwd: string) {
  const names = (await git(cwd, ["remote"])).split("\n").filter(Boolean);
  const remotes: { name: string; repository: string; url: string }[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    const url = await git(cwd, ["remote", "get-url", "--push", name]);
    try {
      remotes.push({ name, repository: remoteRepository(url), url });
    } catch {
      /* Unsupported remotes never leave the daemon. */
    }
  }
  return remotes;
}
export async function validateBranch(cwd: string, branch: string) {
  if (
    !branch ||
    branch.length > 200 ||
    branch.startsWith("-") ||
    /[\r\n\0]/.test(branch) ||
    ["main", "master", "HEAD"].includes(branch)
  )
    throw new Error("shipping_branch_invalid");
  await git(cwd, ["check-ref-format", `refs/heads/${branch}`]);
}
export async function remoteHead(cwd: string, repository: string, branch: string) {
  await validateBranch(cwd, branch);
  const result = await git(cwd, [
    "ls-remote",
    "--refs",
    `https://github.com/${githubRepository(repository)}.git`,
    `refs/heads/${branch}`,
  ]);
  if (!result) return "";
  const [sha, ref] = result.split(/\s+/);
  if (!/^[a-f0-9]{40,64}$/.test(sha ?? "") || ref !== `refs/heads/${branch}`)
    throw new Error("shipping_remote_invalid");
  return sha ?? "";
}
export async function pushExecution(cwd: string) {
  // URL rewrites can redirect an otherwise canonical GitHub destination.
  const config = await git(cwd, ["config", "--name-only", "--list"]);
  if (config.split("\n").some((k) => /^url\..*\.(?:insteadof|pushinsteadof)$/i.test(k)))
    throw new Error("shipping_url_rewrite_unsupported");
  return executionFingerprint(cwd);
}
export async function publishCommit(
  cwd: string,
  repository: string,
  branch: string,
  head: string,
  taskId: string,
) {
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("shipping_commit_invalid");
  await validateBranch(cwd, branch);
  const ref = `refs/zoltbot/published/${createHash("sha256").update(taskId).digest("hex")}`;
  await git(cwd, ["update-ref", ref, head], true);
  // No force, implicit source branch, tags, or automatic source checkout changes.
  await git(
    cwd,
    [
      "-c",
      "push.followTags=false",
      "push",
      "--porcelain",
      `https://github.com/${githubRepository(repository)}.git`,
      `${head}:refs/heads/${branch}`,
    ],
    true,
  );
}
