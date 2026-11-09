import type { ComposerAttachment } from "./composer-draft.js";

// Adapted from T3 Code composerAttachmentFiles.ts at 25bf84ab07f53f141c20239c63e383823a9d5ea0.
// Copyright (c) 2026 T3 Tools Inc. MIT; see docs/third-party/t3-composer-MIT.txt.
const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
export function composerImageMime(file: Pick<File, "name" | "type">): string {
  const mime = file.type.toLowerCase();
  if (mime !== "" && mime !== "application/octet-stream") return mime;
  const dot = file.name.lastIndexOf(".");
  return (dot > 0 && IMAGE_MIME_TYPE_BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()]) || mime;
}

export function attachmentBlockReason(attachments: ComposerAttachment[], images: boolean) {
  if (attachments.some((file) => file.status === "preparing"))
    return "Wait for image preparation to finish.";
  if (attachments.some((file) => file.status === "error"))
    return "Retry or remove the failed attachments before sending.";
  if (!images && attachments.some((file) => file.image))
    return "Images are not available for this connection. Remove them before sending.";
  return "";
}
export const COMPOSER_IMAGE_BYTES = 512 * 1024;
export const COMPOSER_FILE_BYTES = 10 * 1024 * 1024;

export function readComposerImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("The image could not be read. Retry or attach it again."));
    reader.onabort = reader.onerror;
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (value) resolve(value);
      else reject(new Error("The image was empty. Choose another file."));
    };
    reader.readAsDataURL(file);
  });
}

/** Text copied beside an ordinary file remains text; pasted images take precedence. */
export function shouldHandleComposerPaste(files: Pick<File, "name" | "type">[], plainText: string) {
  return (
    files.some((file) => composerImageMime(file).startsWith("image/")) ||
    (!plainText && files.length > 0)
  );
}
