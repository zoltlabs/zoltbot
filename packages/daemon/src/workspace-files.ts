import { opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DomainState } from "@zoltbot/core/projectors";

const excluded = new Set([".git", ".cache", "node_modules", ".next", "dist", "coverage"]);
function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
/** Names only. Never reads file contents or follows child symlinks. */
export async function workspaceFiles(cwd: string, query: string, limit: number) {
  if (query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_file_query");
  const root = await realpath(cwd).catch(() => {
    throw new Error("workspace_unavailable");
  });
  const directories = [root],
    items: { path: string; label: string }[] = [];
  let visited = 0,
    truncated = false;
  while (directories.length) {
    const directory = directories.shift();
    if (!directory) break;
    try {
      const resolved = await realpath(directory);
      if (!inside(root, resolved) || resolved !== directory) continue;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++visited > 5000) {
          truncated = true;
          break;
        }
        if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase())) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const label = path.relative(root, absolute).split(path.sep).join("/");
        if (!label.toLowerCase().includes(query.toLowerCase())) continue;
        if (items.length === limit) {
          truncated = true;
          break;
        }
        items.push({ path: absolute, label });
      }
    } catch {
      if (directory === root) throw new Error("workspace_unavailable");
    }
    if (truncated) break;
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return { items, truncated };
}
export async function listThreadFiles(
  state: DomainState,
  threadId: string,
  query: string,
  limit: number,
) {
  if (!state.thread?.some((row) => row.id === threadId && !row.archived))
    throw new Error("runtime_thread_unavailable");
  const session = state.session
    ?.filter((row) => row.threadId === threadId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (!session || typeof session.cwd !== "string" || !path.isAbsolute(session.cwd))
    throw new Error("workspace_not_ready");
  return workspaceFiles(session.cwd, query, limit);
}
