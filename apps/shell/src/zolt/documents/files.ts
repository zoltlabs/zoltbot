import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, relative, sep } from "node:path";
import { DOCUMENT_EXTENSIONS, DOCUMENT_LIMITS, type DocumentStat } from "../../shared/documents";

/** Folders the document list never walks into. */
const SKIPPED = new Set(["node_modules", "dist", "out", "build", "coverage", "vendor", "target"]);
const MAX_DEPTH = 10;

export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Checks a path the renderer sent: relative, forward slashes, no `..`, a Markdown extension, and
 * no part starting with a dot. Returns it normalized.
 */
export function documentPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    throw new Error("Choose a Markdown file.");
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (
    isAbsolute(value) ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part.startsWith(".") || !part)
  )
    throw new Error("Choose a file inside the project folder.");
  if (!DOCUMENT_EXTENSIONS.includes(extname(normalized).toLowerCase() as never))
    throw new Error("Only Markdown files (.md, .markdown, .mdx) open here.");
  return normalized;
}

/**
 * The absolute file for `path` inside `root`. Refuses symlinks on the way and anything whose real
 * location is outside the project folder.
 */
export async function resolveInRoot(root: string, path: string, mustExist = true): Promise<string> {
  const realRoot = await realpath(root);
  const file = join(realRoot, ...path.split("/"));
  let current = realRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error("Links to files outside the folder can't open here.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !mustExist) break;
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("That file isn't in the project folder anymore.");
      throw error;
    }
  }
  const inside = relative(realRoot, file);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Choose a file inside the project folder.");
  return file;
}

export async function readDocument(file: string): Promise<{ text: string } & DocumentStat> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("That isn't a file.");
  if (info.size > DOCUMENT_LIMITS.bytes)
    throw new Error("This file is larger than 2 MB, too large to edit here.");
  const bytes = await readFile(file);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This file isn't UTF-8 text.");
  }
  return { text, hash: hashText(text), modifiedAt: info.mtime.toISOString() };
}

/** Writes through a temporary file and a rename, so a crash never leaves half a chapter. */
export async function writeDocument(file: string, text: string): Promise<DocumentStat> {
  if (Buffer.byteLength(text) > DOCUMENT_LIMITS.bytes)
    throw new Error("The document is larger than 2 MB, too large to save here.");
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${randomUUID()}.zoltbot-tmp`);
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
  const info = await stat(file);
  return { hash: hashText(text), modifiedAt: info.mtime.toISOString() };
}

export interface ListedFile {
  path: string;
  size: number;
  modifiedAt: string;
}

/** Markdown files under `root`, skipping hidden folders and build output. */
export async function listDocuments(
  root: string,
): Promise<{ files: ListedFile[]; truncated: boolean }> {
  const realRoot = await realpath(root);
  const files: ListedFile[] = [];
  let truncated = false;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await walk(full, depth + 1);
      } else if (
        entry.isFile() &&
        DOCUMENT_EXTENSIONS.includes(extname(entry.name).toLowerCase() as never)
      ) {
        if (files.length >= DOCUMENT_LIMITS.files) {
          truncated = true;
          return;
        }
        try {
          const info = await stat(full);
          files.push({
            path: relative(realRoot, full).split(sep).join("/"),
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        } catch {}
      }
      if (truncated) return;
    }
  };
  await walk(realRoot, 0);
  return { files, truncated };
}
