// C16: loads a sent file or picture from the Mac in link-sized pieces, then shapes it for the
// screen. The Mac refuses anything over 5 MB; the phone stops there too.
import { type DelimitedPreview, parseDelimited } from "@zoltbot/protocol";

export const PHONE_PREVIEW_BYTES = 5 * 1024 * 1024;
/** More pieces than a 5 MB file can need, so a misbehaving Mac can't loop the phone. */
const MAX_PIECES = 80;

interface Piece {
  kind: "image" | "text" | "csv" | "tsv" | "markdown";
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
  | { kind: "table"; name: string; table: DelimitedPreview };

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export async function loadAttachmentPreview(
  call: Call,
  target: { threadId: string; itemId: string; part: number },
): Promise<AttachmentPreview> {
  let piece = (await call("attachment.preview", target)) as Piece;
  const first = piece;
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
  if (code.includes("too_large")) return "This file is over 5 MB. Open it on your Mac.";
  if (code.includes("changed")) return "This file changed while loading. Try again.";
  return "Can't preview this file here. Open it on your Mac.";
}
