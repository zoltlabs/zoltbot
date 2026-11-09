import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { clean, commit, git, repository } from "./git.js";
import { rejectNestedRepositories } from "./hooks.js";

export interface ArchiveSnapshot {
  path: string;
  head: string;
  base: string;
  verified: true;
  commits: string[];
}
/** Bundle validation uses a fresh repository, proving the saved commit can be recovered independently. */
export async function archiveSnapshot(
  cwd: string,
  base: string,
  directory: string,
): Promise<ArchiveSnapshot> {
  const repo = await repository(cwd);
  await clean(repo.root);
  await rejectNestedRepositories(repo.root);
  if (await git(repo.root, ["ls-files", "--others", "--ignored", "--exclude-standard"]))
    throw new Error("archive_ignored_files_require_explicit_preservation");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const originalBase = await commit(repo.root, base);
  const reflog = await git(repo.root, ["reflog", "show", "--format=%H", "HEAD"]);
  const commits = [...new Set([repo.head, originalBase, ...reflog.split("\n").filter(Boolean)])];
  if (commits.length > 1024) throw new Error("archive_history_limit");
  const bundle = path.join(directory, `${randomUUID()}.bundle`);
  await git(repo.root, ["bundle", "create", bundle, "HEAD", ...commits], true);
  const validation = await mkdtemp(path.join(directory, "verify-"));
  try {
    await git(validation, ["init"], true);
    await git(validation, ["bundle", "verify", bundle]);
    await git(validation, ["bundle", "unbundle", bundle], true);
    for (const saved of commits) await git(validation, ["cat-file", "-e", `${saved}^{commit}`]);
    await git(validation, ["fsck", "--full", "--no-reflogs"]);
  } catch (error) {
    await rm(bundle, { force: true });
    throw error;
  } finally {
    await rm(validation, { recursive: true, force: true });
  }
  return { path: bundle, head: repo.head, base: originalBase, commits, verified: true };
}
