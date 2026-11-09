import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { QuickContextRef, QuickContextSource } from "@zoltbot/protocol";
import type { Snapshot } from "@zoltbot/store";

// Explicit, bounded, read-only context for Quick Chat. A source authorizes scoped retrieval
// only: nothing here writes, runs commands, or sends a whole repository.

export const contextBudget = { totalChars: 12_000, perFileChars: 4_000, searchFiles: 4 };
const skippedDirectories = new Set([
  ".git",
  ".cache",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".venv",
  "vendor",
]);
/** Credential files are never read for context, whatever they contain. */
export const sensitiveName =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.json)?|secrets?(\..*)?|.*\.tfstate)$/i;
export const textExtension =
  /\.(md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|css|scss|html|sql|sh|zsh|graphql|proto|ini|cfg|conf|xml|csv)$/i;
export interface ContextPiece {
  ref: QuickContextRef;
  text: string;
}
export interface ContextResult {
  pieces: ContextPiece[];
  /** Readable reasons for sources that contributed nothing, for example a secret was found. */
  notes: string[];
}
function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(".."));
}
const revision = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
export async function readBounded(file: string, limit: number): Promise<string | undefined> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 2_000_000) return undefined;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(limit * 4, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return text.includes("\u0000") ? undefined : text;
  } finally {
    await handle.close();
  }
}
export async function roots(state: Snapshot, projectId: string): Promise<string[]> {
  const project = state.project?.find((row) => row.id === projectId && !row.archived);
  if (!project) throw new Error("quick_context_workspace_unavailable");
  const found: string[] = [];
  for (const root of (project.roots as { path: string }[] | undefined) ?? [])
    try {
      found.push(await realpath(root.path));
    } catch {}
  return found;
}
/** Resolves a file inside one of the workspace's folders, refusing links that leave it. */
export async function workspaceFile(state: Snapshot, projectId: string, file: string) {
  for (const root of await roots(state, projectId)) {
    const candidate = path.isAbsolute(file) ? file : path.join(root, file);
    try {
      const resolved = await realpath(candidate);
      if (inside(root, resolved))
        return {
          absolute: resolved,
          label: path.relative(root, resolved).split(path.sep).join("/"),
        };
    } catch {}
  }
  throw new Error("quick_context_file_unavailable");
}
/** File names for the picker. Names only; contents are read when a message is sent. */
export async function listWorkspaceFiles(state: Snapshot, projectId: string, query: string) {
  const items: { path: string; label: string }[] = [];
  let truncated = false;
  for (const root of await roots(state, projectId)) {
    for await (const file of walk(root, 5000)) {
      const label = path.relative(root, file).split(path.sep).join("/");
      if (sensitiveName.test(label) || !label.toLowerCase().includes(query.toLowerCase())) continue;
      if (items.length === 50) {
        truncated = true;
        break;
      }
      items.push({ path: label, label });
    }
  }
  return { items: items.sort((a, b) => a.label.localeCompare(b.label)), truncated };
}
export async function* walk(root: string, limit: number): AsyncGenerator<string> {
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    const directory = queue.shift() as string;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(directory);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      if (++visited > limit) return;
      if (entry.isSymbolicLink() || skippedDirectories.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) yield absolute;
    }
  }
}
const keywords = (question: string) =>
  [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((word) => word.length > 3),
    ),
  ].slice(0, 8);
function excerpt(text: string, words: string[], limit: number) {
  const lines = text.split("\n");
  const hit = lines.findIndex((line) => words.some((word) => line.toLowerCase().includes(word)));
  const start = Math.max(0, hit - 10);
  let out = "";
  for (let i = start; i < lines.length && out.length < limit; i++) out += `${lines[i]}\n`;
  return { text: out.slice(0, limit), line: start + 1 };
}
/**
 * Gathers context for one message within the budget. `containsSecret` is the host's existing
 * secret filter; text that matches it is dropped, never sent. `previous` holds revisions this
 * chat already sent, so an unchanged excerpt is marked as reused.
 */
export async function gatherContext(input: {
  state: Snapshot;
  sources: readonly QuickContextSource[];
  question: string;
  previous: ReadonlySet<string>;
  containsSecret(text: string): Promise<boolean>;
}): Promise<ContextResult> {
  const pieces: ContextPiece[] = [],
    notes: string[] = [];
  let remaining = contextBudget.totalChars;
  const add = async (
    source: QuickContextSource,
    label: string,
    text: string,
    file?: string,
  ): Promise<boolean> => {
    if (remaining <= 0) {
      notes.push(`${label}: not included, the context budget is full. Narrow the question.`);
      return false;
    }
    if (await input.containsSecret(text)) {
      notes.push(`${label}: skipped because it looks like it contains a secret.`);
      return false;
    }
    const bounded = text.slice(0, Math.min(remaining, contextBudget.perFileChars));
    remaining -= bounded.length;
    const hash = revision(bounded);
    pieces.push({
      text: bounded,
      ref: {
        sourceId: source.id,
        label,
        ...(file ? { path: file } : {}),
        revision: hash,
        chars: bounded.length,
        reused: input.previous.has(`${source.id}:${file ?? ""}:${hash}`),
      },
    });
    return true;
  };
  for (const source of input.sources) {
    try {
      if (source.kind === "brief") {
        const row =
          source.scope.type === "project"
            ? input.state.project?.find((item) => item.id === source.scope.id)
            : input.state.subproject?.find((item) => item.id === source.scope.id);
        if (!row) {
          notes.push(`${source.label}: no longer available.`);
          continue;
        }
        const brief = [
          `Name: ${row.name}`,
          row.goal ? `Goal: ${row.goal}` : "",
          row.instructions ? `Instructions: ${row.instructions}` : "",
          row.constraints ? `Constraints: ${row.constraints}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        await add(source, source.label, brief);
      } else if (source.kind === "file") {
        if (sensitiveName.test(source.path)) {
          notes.push(`${source.label}: credential files are never sent as context.`);
          continue;
        }
        const file = await workspaceFile(input.state, source.projectId, source.path);
        const text = await readBounded(file.absolute, contextBudget.perFileChars);
        if (text === undefined) notes.push(`${source.label}: not a readable text file.`);
        else await add(source, source.label, text, file.label);
      } else {
        const words = keywords(input.question);
        if (!words.length) continue;
        const scored: { file: string; label: string; text: string; score: number }[] = [];
        for (const root of await roots(input.state, source.projectId))
          for await (const file of walk(root, 3000)) {
            const label = path.relative(root, file).split(path.sep).join("/");
            if (sensitiveName.test(label) || !textExtension.test(file)) continue;
            const text = await readBounded(file, 50_000).catch(() => undefined);
            if (!text) continue;
            const lower = text.toLowerCase(),
              name = label.toLowerCase();
            const score = words.reduce(
              (sum, word) => sum + (name.includes(word) ? 5 : 0) + (lower.includes(word) ? 1 : 0),
              0,
            );
            if (score > 0) scored.push({ file, label, text, score });
          }
        scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
        const top = scored.slice(0, contextBudget.searchFiles);
        if (!top.length) notes.push(`${source.label}: no matching files for this question.`);
        for (const match of top) {
          const part = excerpt(match.text, words, 1500);
          await add(source, `${source.label}: ${match.label}:${part.line}`, part.text, match.label);
        }
      }
    } catch {
      notes.push(`${source.label}: could not be read on this host.`);
    }
  }
  return { pieces, notes };
}
