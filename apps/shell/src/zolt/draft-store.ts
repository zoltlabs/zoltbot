import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileMimeType, filePreviewKind, isProviderImage } from "@zoltbot/protocol";
import type { DraftAttachment } from "../shared/ipc";
import { attachmentUrl } from "./sent-attachments";

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

  async addBytes(folder: string, name: string, bytes: Uint8Array): Promise<DraftAttachment> {
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
