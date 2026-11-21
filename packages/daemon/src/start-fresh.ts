// D6: Start fresh. The daemon can't delete the store it has open, so it marks the data folder,
// exits, and wipes the folder the next time it starts, before it opens anything.
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** The file that asks the next start to wipe the data folder. */
export const FRESH_START_MARK = "start-fresh";

const SECRET_REFERENCE = /^keychain:zoltbot:[A-Za-z0-9-]+$/;

/** Every keychain reference stored anywhere in `value`, once each. */
export function secretReferences(value: unknown, found = new Set<string>()): string[] {
  if (typeof value === "string") {
    if (SECRET_REFERENCE.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) secretReferences(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) secretReferences(item, found);
  }
  return [...found];
}

/** Worktrees agents made for tasks. Kept: they may hold work, and git still lists them. */
export const MANAGED_WORKTREES = "managed-worktrees";

/** Files that hold a keychain reference outside the store, such as the account's. */
const REFERENCE_FILES = ["desktop/account-keychain-reference", "shell/account-keychain-reference"];

/** Keychain references kept in files in the data folder. */
async function fileReferences(dataDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of REFERENCE_FILES) {
    const text = await readFile(path.join(dataDir, file), "utf8").catch(() => "");
    found.push(...secretReferences(text.trim()));
  }
  return found;
}

/**
 * Whether `dataDir` is safe to empty: Zoltbot's own folder, with its store in it, and never the
 * home folder or the disk's root.
 */
export function isDataFolder(dataDir: string): boolean {
  const resolved = path.resolve(dataDir);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(homedir())) return false;
  return existsSync(path.join(resolved, "zoltbot.db"));
}

/** The `.zoltbot` folders inside the owner's repositories: kept, and listed for the owner. */
export function repositoryFolders(
  roots: readonly (string | null | undefined)[],
  dataDir?: string,
): string[] {
  const folders = new Set<string>();
  const inside = (folder: string) =>
    !!dataDir && !path.relative(path.resolve(dataDir), folder).startsWith("..");
  for (const root of roots) {
    if (!root || !path.isAbsolute(root) || inside(root)) continue;
    const folder = path.join(root, ".zoltbot");
    if (existsSync(folder)) folders.add(folder);
  }
  return [...folders].sort();
}

export interface StartFreshHost {
  dataDir: string;
  /** Everything the store holds, to find keychain references in. */
  snapshot: () => unknown;
  /** Stops every running turn. */
  interruptAll: () => Promise<void>;
  removeSecret?: (reference: string) => Promise<void>;
  /** Folders the owner's repositories live in. */
  repositoryRoots: () => (string | null | undefined)[];
}

/**
 * Stops the work, removes the saved logins from the keychain and marks the data folder for
 * wiping. Returns the repository folders it leaves alone. The caller exits the daemon next.
 */
export async function prepareFreshStart(host: StartFreshHost): Promise<{ kept: string[] }> {
  if (!isDataFolder(host.dataDir)) throw new Error("start_fresh_unsafe_folder");
  await host.interruptAll();
  const references = new Set([
    ...secretReferences(host.snapshot()),
    ...(await fileReferences(host.dataDir)),
  ]);
  // A login that can't be removed stops it here, before the folder is marked.
  for (const reference of references) await host.removeSecret?.(reference);
  await writeFile(path.join(host.dataDir, FRESH_START_MARK), new Date().toISOString(), {
    mode: 0o600,
  });
  const worktrees = path.join(host.dataDir, MANAGED_WORKTREES);
  return {
    kept: [
      ...repositoryFolders(host.repositoryRoots(), host.dataDir),
      ...(existsSync(worktrees) ? [worktrees] : []),
    ],
  };
}

/** On start: if the data folder is marked, empties it. Returns whether it did. */
export async function finishFreshStart(dataDir: string): Promise<boolean> {
  if (!existsSync(path.join(dataDir, FRESH_START_MARK))) return false;
  if (!isDataFolder(dataDir)) throw new Error("start_fresh_unsafe_folder");
  for (const entry of await readdir(dataDir)) {
    // The lock that makes this daemon the only one is already held: keep it. Agents' worktrees
    // may hold work git still knows about: the owner removes them.
    if (entry.startsWith("daemon-owner.sqlite") || entry === MANAGED_WORKTREES) continue;
    await rm(path.join(dataDir, entry), { recursive: true, force: true });
  }
  return true;
}
