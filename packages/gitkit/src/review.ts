import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { commit, git, repository, repositoryLock } from "./git.js";
import { executionFingerprint, rejectActiveHook, rejectNestedRepositories } from "./hooks.js";

export interface ReviewFile {
  path: string;
  hash: string;
  excluded?: string;
}
export interface ReviewPreview {
  cwd: string;
  head: string;
  base: string;
  files: ReviewFile[];
  committedPaths: string[];
  fingerprint: string;
  executionHash: string;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function previewReview(cwd: string, base: string): Promise<ReviewPreview> {
  const repo = await repository(cwd);
  await rejectNestedRepositories(repo.root);
  const files: ReviewFile[] = [];
  const tracked = await git(cwd, ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const staged = (await git(cwd, ["diff", "--cached", "--no-ext-diff", "--name-only", "-z", "--"]))
    .split("\0")
    .filter(Boolean);
  const unstaged = new Set(
    (await git(cwd, ["diff", "--no-ext-diff", "--name-only", "-z", "--"]))
      .split("\0")
      .filter(Boolean),
  );
  if (staged.some((file) => unstaged.has(file)))
    throw new Error("partial_staging_requires_resolution");
  for (const relative of [
    ...new Set([...tracked.split("\0"), ...staged, ...untracked.split("\0")].filter(Boolean)),
  ].sort()) {
    const target = path.resolve(repo.root, relative);
    if (!target.startsWith(`${repo.root}${path.sep}`)) throw new Error("unsafe_review_path");
    let file: ReviewFile;
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink())
        file = { path: relative, hash: hash(`link:${await readlink(target)}`) };
      else if (!info.isFile()) file = { path: relative, hash: "", excluded: "Not a regular file" };
      else if (info.size > 1024 * 1024)
        file = { path: relative, hash: "", excluded: "Larger than 1 MiB" };
      else {
        const bytes = await readFile(target);
        file = { path: relative, hash: hash(bytes) };
        if (
          /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(pem|key|p12)$/i.test(
            relative,
          ) ||
          /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(bytes.toString("utf8"))
        )
          file.excluded =
            "Potential secret; remove or ignore this file before creating a review commit";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      file = { path: relative, hash: "deleted" };
    }
    files.push(file);
  }
  const body = {
    cwd: repo.root,
    head: repo.head,
    base: await commit(repo.root, base),
    files,
    committedPaths: (
      await git(cwd, [
        "diff",
        "--no-ext-diff",
        "--name-only",
        "-z",
        await commit(cwd, base),
        repo.head,
        "--",
      ])
    )
      .split("\0")
      .filter(Boolean),
    executionHash: await executionFingerprint(cwd),
    index: await git(cwd, ["ls-files", "--stage", "-z"]),
  };
  return {
    cwd: body.cwd,
    head: body.head,
    base: body.base,
    files,
    committedPaths: body.committedPaths,
    fingerprint: hash(JSON.stringify(body)),
    executionHash: body.executionHash,
  };
}
export async function createReviewCommit(
  preview: ReviewPreview,
  message: string,
  confirmed: boolean,
  approvedExecutionHash?: string,
) {
  if (!confirmed) throw new Error("confirmation_required");
  if (!message.trim() || message.length > 500) throw new Error("invalid_commit_message");
  const repo = await repository(preview.cwd);
  return repositoryLock(repo.commonDir, async () => {
    const current = await previewReview(preview.cwd, preview.base);
    if (current.fingerprint !== preview.fingerprint) throw new Error("review_preview_stale");
    if (!current.files.length) {
      if (current.head === current.base) throw new Error("no_review_changes");
      return {
        head: current.head,
        base: current.base,
        previous: current.head,
        cumulative: await git(repo.root, ["diff", "--stat", current.base, current.head, "--"]),
        incremental: "",
      };
    }
    if (current.files.some((file) => file.excluded)) throw new Error("review_files_excluded");
    try {
      await git(repo.root, ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]);
      await git(repo.root, ["-c", "user.useConfigOnly=true", "var", "GIT_COMMITTER_IDENT"]);
    } catch {
      throw new Error("git_identity_required");
    }
    const executionApproved = approvedExecutionHash === current.executionHash;
    // Until the host durable code-execution approval route is bound, these configurations fail closed.
    for (const name of [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "post-rewrite",
      "reference-transaction",
      "post-index-change",
    ])
      if (!executionApproved) await rejectActiveHook(repo.root, name);
    let signing = "";
    try {
      signing = await git(repo.root, ["config", "--get", "commit.gpgsign"]);
    } catch {}
    if (signing === "true" && !executionApproved)
      throw new Error("signing_execution_approval_required");
    const attributes = await git(repo.root, [
      "check-attr",
      "filter",
      "--",
      ...current.files.map((file) => file.path),
    ]);
    if (
      !executionApproved &&
      attributes
        .split("\n")
        .some((line) => !line.endsWith(": unspecified") && !line.endsWith(": unset"))
    )
      throw new Error("filter_execution_approval_required");
    await git(repo.root, ["add", "--", ...current.files.map((file) => file.path)], true);
    await git(repo.root, ["commit", "-m", message], true);
    const head = await commit(repo.root, "HEAD");
    return {
      head,
      base: current.base,
      previous: current.head,
      cumulative: await git(repo.root, ["diff", "--stat", current.base, head, "--"]),
      incremental: await git(repo.root, ["diff", "--stat", current.head, head, "--"]),
    };
  });
}
