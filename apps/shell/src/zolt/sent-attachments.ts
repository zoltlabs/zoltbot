// C16: files and pictures the owner sent stay on their message after it's delivered. Each one is
// named by its message and part (`item:<itemId>:<part>`), and main reads it from the daemon's
// copy of that message, never from a path the window sends.
import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileMimeType, filePreviewKind } from "@zoltbot/protocol";
import type { AttachmentSummary } from "../shared/ipc";
import type { Row } from "./daemon-client";

const PREFIX = "item:";
const sizes = new Map<string, number>();

/** Size on disk, read once per path; a missing file reads as 0. */
function sizeOf(path: string): number {
  const known = sizes.get(path);
  if (known !== undefined) return known;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {}
  if (sizes.size > 2000) sizes.clear();
  sizes.set(path, size);
  return size;
}

const bodyOf = (item: Row): Row =>
  item.body && typeof item.body === "object" ? (item.body as Row) : {};

export const attachmentUrl = (id: string) => `openbot-attachment://file/${encodeURIComponent(id)}`;

function ownerParts(item: Row): Row[] {
  const body = bodyOf(item);
  if (item.kind !== "user" || body.origin === "agent" || !Array.isArray(body.input)) return [];
  return body.input as Row[];
}

/** The files and pictures in one of the owner's messages, as attachment cards. */
export function sentAttachments(item: Row): AttachmentSummary[] {
  const attachments: AttachmentSummary[] = [];
  ownerParts(item).forEach((part, index) => {
    if (part.type !== "file" && part.type !== "image") return;
    const id = `${PREFIX}${String(item.id)}:${index}`;
    const path = typeof part.path === "string" ? part.path : "";
    if (!path) {
      const base64 = typeof part.base64 === "string" ? part.base64 : "";
      if (!base64) return;
      const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/jpeg";
      attachments.push({
        id,
        name: "Photo",
        size: Math.floor((base64.length * 3) / 4),
        kind: "image",
        mimeType,
        previewKind: "image",
        previewUrl: attachmentUrl(id),
        actions: [],
      });
      return;
    }
    const previewKind = isAbsolute(path) ? filePreviewKind(path) : "none";
    attachments.push({
      id,
      name: basename(path),
      size: isAbsolute(path) ? sizeOf(path) : 0,
      kind: part.type === "image" ? "image" : "file",
      mimeType: fileMimeType(path),
      previewKind,
      previewUrl: previewKind === "none" ? null : attachmentUrl(id),
      // A paired phone can name any path in a message, so only documents with a preview open in
      // their app; anything else, such as an app or a script, is only shown in Finder.
      actions: previewKind === "none" ? (isAbsolute(path) ? ["reveal"] : []) : ["open", "reveal"],
    });
  });
  return attachments;
}

export type AttachmentSource =
  | { path: string; mimeType: string }
  | { bytes: Uint8Array; mimeType: string };

/** Where a sent attachment's bytes are, or undefined when the id names no owner part. */
export function sentAttachmentSource(
  items: readonly Row[],
  id: string,
): AttachmentSource | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  const split = id.lastIndexOf(":");
  const itemId = id.slice(PREFIX.length, split);
  const index = Number(id.slice(split + 1));
  if (!itemId || !Number.isInteger(index) || index < 0) return undefined;
  const item = items.find((row) => row.id === itemId);
  const part = item ? ownerParts(item)[index] : undefined;
  if (part?.type !== "file" && part?.type !== "image") return undefined;
  if (typeof part.path === "string" && part.path) {
    return isAbsolute(part.path)
      ? { path: part.path, mimeType: fileMimeType(part.path) }
      : undefined;
  }
  if (part.type !== "image" || typeof part.base64 !== "string") return undefined;
  const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/jpeg";
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) return undefined;
  return { bytes: Buffer.from(part.base64, "base64"), mimeType };
}
