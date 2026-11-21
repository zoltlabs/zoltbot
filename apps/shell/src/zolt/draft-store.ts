import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  fileMimeType,
  filePreviewKind,
  isProviderImage,
} from "@zoltbot/protocol";
import type { DraftAttachment } from "../shared/ipc";
import { attachmentUrl } from "./sent-attachments";

/**
 * C18: refuses a file over 100 MB, naming it, before anything in its batch is attached. With
 * other files picked alongside it, the message says none of them were attached.
 */
export function checkAttachmentSize(name: string, size: number, batch = 1): void {
  if (size <= ATTACHMENT_MAX_BYTES) return;
  throw new Error(
    batch > 1
      ? `${basename(name)} is over 100 MB, so no files were attached.`
      : `${basename(name)} is over 100 MB, so it wasn't attached.`,
  );
}

/** Files picked or pasted into the composer, kept by id until the message is sent. */
export class DraftStore {
  private readonly drafts = new Map<string, { path: string; summary: DraftAttachment }>();

  add(path: string, size: number): DraftAttachment {
    const id = randomUUID();
    const previewKind = filePreviewKind(path);
    const summary: DraftAttachment = {
      id,
      name: basename(path),
      size,
      kind: isProviderImage(path) ? "image" : "file",
      mimeType: fileMimeType(path),
      previewKind,
      previewUrl: previewKind === "none" ? null : attachmentUrl(id),
      actions: ["open", "reveal"],
    };
    this.drafts.set(summary.id, { path, summary });
    return summary;
  }

  /** Adds picked files, or none of them when one is too big. */
  addAll(files: { path: string; size: number }[]): DraftAttachment[] {
    for (const file of files) checkAttachmentSize(file.path, file.size, files.length);
    return files.map((file) => this.add(file.path, file.size));
  }

  async addBytes(folder: string, name: string, bytes: Uint8Array): Promise<DraftAttachment> {
    checkAttachmentSize(name, bytes.byteLength);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${randomUUID()}-${basename(name).slice(0, 120)}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return this.add(path, bytes.byteLength);
  }

  get(id: string): { path: string; summary: DraftAttachment } | undefined {
    return this.drafts.get(id);
  }

  path(id: string): string | undefined {
    return this.drafts.get(id)?.path;
  }

  delete(id: string): void {
    this.drafts.delete(id);
  }
}
