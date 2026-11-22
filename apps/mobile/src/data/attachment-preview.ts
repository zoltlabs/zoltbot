// C16: loads a sent file or picture from the Mac in link-sized pieces, then shapes it for the
// screen. The Mac refuses anything over 5 MB, or over 25 MB for a PDF and 50 MB for a video; the
// phone stops there too. PDFs and videos go to a file in the cache, a piece at a time, for the
// system viewer to open.
import { type DelimitedPreview, parseDelimited, type ZipListing } from "@zoltbot/protocol";

export const PHONE_PREVIEW_BYTES = 5 * 1024 * 1024;
export const SAVED_BYTES = { pdf: 25 * 1024 * 1024, video: 50 * 1024 * 1024 } as const;
/** More pieces than a 5 MB file can need, so a misbehaving Mac can't loop the phone. */
const MAX_PIECES = 80;

interface Piece {
  kind: "image" | "svg" | "text" | "csv" | "tsv" | "markdown" | "zip" | "pdf" | "video";
  name: string;
  mime: string;
  size: number;
  stamp: string;
  data: string;
  next: number | null;
}

export type AttachmentPreview =
  | { kind: "image"; name: string; uri: string }
  | { kind: "text" | "markdown"; name: string; text: string }
  | { kind: "table"; name: string; table: DelimitedPreview }
  | { kind: "zip"; name: string; listing: ZipListing }
  | { kind: "svg"; name: string; xml: string }
  | SavedPreview;

interface Saved<K> {
  kind: K;
  name: string;
  mime: string;
  size: number;
  uri: string;
}
/** A PDF or video saved on the phone. Two members so a kind check narrows to one. */
export type SavedPreview = Saved<"pdf"> | Saved<"video">;

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Where a PDF or video is written; the app passes the cache, tests pass memory. */
export interface SavedFile {
  uri: string;
  append(base64: string): void;
  remove(): void;
}
export type SaveFile = (name: string) => Promise<SavedFile>;

/** The file name the system viewer sees: the original, made safe, extension kept. */
export function savedName(name: string, stamp: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
  const tag = stamp.replace(/[^A-Za-z0-9]+/g, "").slice(-12);
  return `${tag}-${safe}`;
}

async function saveToFile(
  call: Call,
  target: { threadId: string; itemId: string; part: number },
  first: Piece & { kind: "pdf" | "video" },
  save: SaveFile,
  progress?: (share: number) => void,
): Promise<AttachmentPreview> {
  if (first.size > SAVED_BYTES[first.kind]) throw new Error("attachment_preview_too_large");
  const encoded = Math.ceil(first.size / 3) * 4;
  // Pieces are at least 100,000 characters, so this bounds a misbehaving Mac.
  const limit = Math.ceil(encoded / 100_000) + 2;
  const file = await save(savedName(first.name, first.stamp));
  try {
    let piece: Piece = first;
    let written = 0;
    for (let count = 1; ; count++) {
      if (!/^[A-Za-z0-9+/=]*$/.test(piece.data)) throw new Error("attachment_preview_unavailable");
      file.append(piece.data);
      written += piece.data.length;
      progress?.(encoded ? written / encoded : 1);
      if (piece.next === null) break;
      if (count >= limit || piece.next !== written || piece.data.length % 4)
        throw new Error("attachment_changed");
      piece = (await call("attachment.preview", {
        ...target,
        offset: piece.next,
        stamp: first.stamp,
      })) as Piece;
    }
    if (written !== encoded) throw new Error("attachment_changed");
  } catch (error) {
    file.remove();
    throw error;
  }
  const saved = { name: first.name, mime: first.mime, size: first.size, uri: file.uri };
  return first.kind === "pdf" ? { kind: "pdf", ...saved } : { kind: "video", ...saved };
}

export async function loadAttachmentPreview(
  call: Call,
  target: { threadId: string; itemId: string; part: number },
  save?: SaveFile,
  progress?: (share: number) => void,
): Promise<AttachmentPreview> {
  let piece = (await call("attachment.preview", target)) as Piece;
  const first = piece;
  if (first.kind === "pdf" || first.kind === "video") {
    if (!save) throw new Error("attachment_preview_unavailable");
    return saveToFile(call, target, first as Piece & { kind: "pdf" | "video" }, save, progress);
  }
  if (first.size > PHONE_PREVIEW_BYTES) throw new Error("attachment_preview_too_large");
  let data = piece.data;
  for (let count = 1; piece.next !== null; count++) {
    if (count >= MAX_PIECES || piece.next !== data.length) throw new Error("attachment_changed");
    piece = (await call("attachment.preview", {
      ...target,
      offset: piece.next,
      stamp: first.stamp,
    })) as Piece;
    data += piece.data;
  }
  if (first.kind === "image") {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(first.mime) || !/^[A-Za-z0-9+/=]*$/.test(data))
      throw new Error("attachment_preview_unavailable");
    return { kind: "image", name: first.name, uri: `data:${first.mime};base64,${data}` };
  }
  if (first.kind === "zip") {
    const listing = JSON.parse(data) as ZipListing;
    if (!Array.isArray(listing.entries)) throw new Error("attachment_preview_unavailable");
    return { kind: "zip", name: first.name, listing };
  }
  if (first.kind === "svg") return { kind: "svg", name: first.name, xml: data };
  if (first.kind === "csv" || first.kind === "tsv")
    return {
      kind: "table",
      name: first.name,
      table: parseDelimited(data, first.kind === "csv" ? "," : "\t"),
    };
  return { kind: first.kind, name: first.name, text: data };
}

/** What to say when a preview can't load. */
export function previewProblem(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.includes("too_large"))
    return "This file is too big for your phone. Open it on your Mac.";
  if (code.includes("changed")) return "This file changed while loading. Try again.";
  return "Can't preview this file here. Open it on your Mac.";
}
