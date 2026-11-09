import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { NativeSessionInfo } from "@zoltbot/protocol";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/** Metadata only: encoded project directory names cannot establish a cwd. */
export async function listClaudeSessions(
  configRoot: string,
  at = new Date().toISOString(),
): Promise<NativeSessionInfo[]> {
  const root = path.resolve(configRoot);
  try {
    if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
      throw new Error("unsafe_native_session_root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const projects = path.join(root, "projects");
  try {
    if ((await lstat(projects)).isSymbolicLink()) throw new Error("unsafe_native_session_root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found = new Map<string, NativeSessionInfo>();
  let visited = 0;
  for (const directory of await readdir(projects, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const folder = path.join(projects, directory.name);
    if ((await realpath(folder)) !== folder) throw new Error("native_session_directory_changed");
    for (const file of await readdir(folder, { withFileTypes: true })) {
      if (++visited > 100000) throw new Error("native_session_listing_limit");
      if (!file.isFile() || file.isSymbolicLink() || !uuid.test(file.name)) continue;
      const metadata = await lstat(path.join(folder, file.name));
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const nativeId = file.name.slice(0, -6);
      const lastActivityAt = metadata.mtime.toISOString();
      const previous = found.get(nativeId);
      if (previous?.lastActivityAt && previous.lastActivityAt >= lastActivityAt) continue;
      found.set(nativeId, {
        provider: "claude",
        nativeId,
        lastActivityAt,
        source: "native",
        adopted: false,
        missing: false,
        lastSeenAt: at,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.nativeId.localeCompare(b.nativeId));
}
