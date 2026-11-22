// C16: attachment.preview reads a file or picture the owner sent in a chat, so the phone can show
// it. Only the owner's own message parts are readable, never a path a caller names, and only the
// kinds the phone can show, up to 5 MB; PDFs up to 25 MB and videos up to 50 MB, which the phone
// saves to a file and opens in the system viewer. A paired phone can send a message naming any path, so a
// file must also sit inside the chat's workspace, outside hidden folders: files the phone could
// already find with workspace.files.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileMimeType, filePreviewKind, readZipListing } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { inside } from "./workspace-files.js";

type Row = Record<string, unknown>;

export const PHONE_PREVIEW_BYTES = 5 * 1024 * 1024;
// One link frame carries about 785 KB of JSON. Text can grow when escaped, base64 can't.
const TEXT_CHUNK = 100_000;
const BASE64_CHUNK = 512_000;
const KINDS = new Set(["image", "svg", "text", "csv", "tsv", "markdown", "zip"]);
/** Kinds sent as base64 straight from disk, one piece per call, so a big file is never held. */
export const STREAMED_BYTES: Record<string, number> = {
  pdf: 25 * 1024 * 1024,
  video: 50 * 1024 * 1024,
};
// A multiple of 4, so every piece decodes on its own and the phone can append it to a file.
const STREAM_CHUNK = BASE64_CHUNK;

type Kind = "image" | "svg" | "text" | "csv" | "tsv" | "markdown" | "zip" | "pdf" | "video";

interface Source {
  name: string;
  kind: Kind;
  mime: string;
  bytes: Buffer;
  stamp: string;
}

interface Streamed {
  name: string;
  kind: "pdf" | "video";
  mime: string;
  file: string;
}

function unavailable(): never {
  throw new Error("attachment_preview_unavailable");
}

/** The part of the owner's message, as a path or inline picture; agents' messages don't count. */
export function ownerPart(item: Row | undefined, threadId: string, index: number): Row | undefined {
  if (!item || item.threadId !== threadId || item.kind !== "user") return undefined;
  const body = (item.body ?? {}) as Row;
  if (body.origin === "agent" || !Array.isArray(body.input)) return undefined;
  const part = (body.input as Row[])[index];
  return part?.type === "file" || part?.type === "image" ? part : undefined;
}

/** The chat's workspace folder, resolved, or undefined before it has one. */
async function workspaceRoot(store: Store, threadId: string): Promise<string | undefined> {
  const session = store
    .snapshot()
    .session?.filter((row) => row.threadId === threadId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (typeof session?.cwd !== "string" || !path.isAbsolute(session.cwd)) return undefined;
  return realpath(session.cwd).catch(() => undefined);
}

/** The file's real path when it sits in the workspace and in no hidden folder; else refuses. */
async function inWorkspace(file: string, root: string | undefined): Promise<string> {
  if (!root || !path.isAbsolute(file)) unavailable();
  const real = await realpath(file).catch(() => unavailable());
  const relative = path.relative(root, real);
  if (!inside(root, real) || relative.split(path.sep).some((segment) => segment.startsWith(".")))
    unavailable();
  return real;
}

/** The file's bytes, or for a ZIP its file list as JSON, read from its index (C18). */
async function openFile(file: string) {
  try {
    return await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    unavailable();
  }
}

async function fileStat(handle: Awaited<ReturnType<typeof open>>) {
  const stat = await handle.stat();
  if (!stat.isFile()) unavailable();
  return { size: stat.size, stamp: `${stat.size}:${Math.trunc(stat.mtimeMs)}:${stat.ino}` };
}

async function readCapped(file: string, zip: boolean): Promise<{ bytes: Buffer; stamp: string }> {
  const handle = await openFile(file);
  try {
    const stat = await fileStat(handle);
    const stamp = stat.stamp;
    if (zip) {
      const listing = await readZipListing(async (offset, length) => {
        const piece = Buffer.alloc(length);
        const { bytesRead } = await handle.read(piece, 0, length, offset);
        return piece.subarray(0, bytesRead);
      }, stat.size).catch(() => unavailable());
      return { bytes: Buffer.from(JSON.stringify(listing)), stamp };
    }
    if (stat.size > PHONE_PREVIEW_BYTES) throw new Error("attachment_preview_too_large");
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    return { bytes: bytes.subarray(0, bytesRead), stamp };
  } finally {
    await handle.close();
  }
}

/** One base64 piece of a PDF or video, read from its byte range only. */
async function streamPiece(source: Streamed, offset: number, stamp: unknown) {
  const handle = await openFile(source.file);
  try {
    const stat = await fileStat(handle);
    if (stat.size > (STREAMED_BYTES[source.kind] ?? 0))
      throw new Error("attachment_preview_too_large");
    if (typeof stamp === "string" && stamp !== stat.stamp) throw new Error("attachment_changed");
    const encoded = Math.ceil(stat.size / 3) * 4;
    if (offset % 4 !== 0 || offset > encoded) throw new Error("attachment_changed");
    const start = (offset / 4) * 3;
    const length = Math.min(stat.size - start, (STREAM_CHUNK / 4) * 3);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, start);
    if (bytesRead !== length) throw new Error("attachment_changed");
    const data = bytes.toString("base64");
    const end = offset + data.length;
    return {
      kind: source.kind,
      name: source.name,
      mime: source.mime,
      size: stat.size,
      stamp: stat.stamp,
      data,
      next: end < encoded ? end : null,
    };
  } finally {
    await handle.close();
  }
}

async function source(
  part: Row,
  root: () => Promise<string | undefined>,
): Promise<Source | Streamed> {
  if (part.type === "image" && typeof part.base64 === "string" && !part.path) {
    const bytes = Buffer.from(part.base64, "base64");
    if (bytes.length > PHONE_PREVIEW_BYTES) throw new Error("attachment_preview_too_large");
    const mime = typeof part.mimeType === "string" ? part.mimeType : "image/jpeg";
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) unavailable();
    const stamp = createHash("sha256").update(part.base64).digest("hex").slice(0, 16);
    return { name: "Photo", kind: "image", mime, bytes, stamp };
  }
  const file = typeof part.path === "string" ? part.path : "";
  const kind = filePreviewKind(file);
  if (file && (kind === "pdf" || kind === "video"))
    return {
      name: path.basename(file),
      kind,
      mime: fileMimeType(file),
      file: await inWorkspace(file, await root()),
    };
  if (!file || !KINDS.has(kind)) unavailable();
  const read = await readCapped(await inWorkspace(file, await root()), kind === "zip");
  return {
    name: path.basename(file),
    kind: kind as Source["kind"],
    mime: fileMimeType(file),
    ...read,
  };
}

export function attachmentPreviewApi(host: { store: Store }) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method !== "attachment.preview") return undefined;
    const threadId = String(params.threadId);
    const part = ownerPart(
      host.store.record("item", String(params.itemId)),
      threadId,
      Number(params.part),
    );
    if (!part) unavailable();
    const file = await source(part, () => workspaceRoot(host.store, threadId));
    const offset = typeof params.offset === "number" ? params.offset : 0;
    if (!("bytes" in file)) return streamPiece(file, offset, params.stamp);
    if (typeof params.stamp === "string" && params.stamp !== file.stamp)
      throw new Error("attachment_changed");
    const data =
      file.kind === "image" ? file.bytes.toString("base64") : file.bytes.toString("utf8");
    if (offset > data.length) throw new Error("attachment_changed");
    let end = Math.min(data.length, offset + (file.kind === "image" ? BASE64_CHUNK : TEXT_CHUNK));
    // Never split a surrogate pair across pieces.
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1] ?? "")) end--;
    return {
      kind: file.kind,
      name: file.name,
      mime: file.mime,
      size: file.bytes.length,
      stamp: file.stamp,
      data: data.slice(offset, end),
      next: end < data.length ? end : null,
    };
  };
}
