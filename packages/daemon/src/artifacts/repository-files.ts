import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { artifactPath, checkedAncestors, safeFile } from "./intake.js";
export const repositoryFileLimit = 1024 * 1024;
export async function repositoryDirectory(root: string, relative: string) {
  await checkedAncestors(root);
  let current = root;
  for (const part of artifactPath(relative).split("/")) {
    current = path.join(current, part);
    let info = await lstat(current).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!info) {
      await mkdir(current, { mode: 0o755 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("artifact_repository_symlink_denied");
  }
  await checkedAncestors(current);
  return current;
}
export async function atomicRepositoryFile(
  root: string,
  relative: string,
  bytes: Buffer,
  immutable = false,
) {
  artifactPath(relative);
  if (bytes.length > repositoryFileLimit) throw Error("artifact_repository_file_limit");
  const parent = path.dirname(relative);
  const directory = parent === "." ? root : await repositoryDirectory(root, parent);
  await checkedAncestors(directory);
  const target = path.join(root, relative);
  const existing = await lstat(target).catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
    throw Error("artifact_repository_file_denied");
  if (existing && immutable) {
    if (!(await safeFile(root, relative)).equals(bytes))
      throw Error("artifact_repository_version_conflict");
    return;
  }
  const temporary = path.join(directory, `.write-${randomUUID()}`);
  try {
    const file = await open(temporary, "wx", 0o644);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await checkedAncestors(directory);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function replaceRepositoryFolder(
  root: string,
  name: string,
  fill: (directory: string) => Promise<void>,
) {
  artifactPath(name);
  await checkedAncestors(root);
  const target = path.join(root, name),
    temporary = path.join(root, `.current-${randomUUID()}`),
    backup = path.join(root, `.previous-${randomUUID()}`);
  const existing = await lstat(target).catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw Error("artifact_repository_directory_denied");
  await mkdir(temporary);
  let moved = false;
  try {
    await fill(temporary);
    if (existing) {
      await rename(target, backup);
      moved = true;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (moved) await rename(backup, target);
      throw error;
    }
    if (moved) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function existingRepositoryJson(root: string, relative: string) {
  const target = path.join(root, artifactPath(relative));
  const info = await lstat(target).catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (!info) return undefined;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > repositoryFileLimit
  )
    throw Error("artifact_repository_file_denied");
  await checkedAncestors(path.dirname(target));
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await safeFile(root, relative)),
    ) as Record<string, unknown>;
  } catch {
    throw Error("artifact_repository_invalid_resolve_conflict");
  }
}

/** Reserved transaction names only. Never follow links or remove ordinary repository files. */
export async function cleanupRepositoryTemps(base: string) {
  await checkedAncestors(base);
  const entries = await boundedRepositoryEntries(base, 1000);
  const backups = entries.filter((e) => /^\.previous-[0-9a-f-]{36}$/.test(e.name));
  const current = path.join(base, "current");
  const existing = await lstat(current).catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (backups.some((e) => !e.isDirectory() || e.isSymbolicLink()) || existing?.isSymbolicLink())
    throw Error("artifact_repository_directory_denied");
  if (!existing && backups.length > 1) throw Error("artifact_repository_recovery_required");
  if (!existing && backups[0]) await rename(path.join(base, backups[0].name), current);
  for (const entry of entries) {
    if (!/^\.(current|previous|write)-[0-9a-f-]{36}$/.test(entry.name)) continue;
    if (!existing && entry.name === backups[0]?.name) continue;
    if (entry.isSymbolicLink()) throw Error("artifact_repository_symlink_denied");
    await rm(path.join(base, entry.name), { recursive: entry.isDirectory(), force: true });
  }
}
export async function cleanupRepositoryRoot(root: string) {
  const base = path.join(root, ".zoltbot", "artifacts");
  try {
    await checkedAncestors(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const entries = await boundedRepositoryEntries(base, 1000);
  for (const entry of entries) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw Error("artifact_repository_directory_denied");
    await cleanupRepositoryTemps(path.join(base, entry.name));
  }
}

export async function boundedRepositoryEntries(folder: string, limit: number) {
  const entries: import("node:fs").Dirent[] = [];
  for await (const entry of await opendir(folder)) {
    if (entries.length >= limit) throw Error("artifact_repository_index_limit");
    entries.push(entry);
  }
  return entries;
}
