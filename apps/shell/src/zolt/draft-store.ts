import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { DraftAttachment } from "../shared/ipc";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Files picked or pasted into the composer, kept by id until the message is sent. */
export class DraftStore {
  private readonly drafts = new Map<string, { path: string; summary: DraftAttachment }>();

  add(path: string, size: number): DraftAttachment {
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const summary: DraftAttachment = {
      id: randomUUID(),
      name: basename(path),
      size,
      kind: mimeType.startsWith("image/") ? "image" : "file",
      mimeType,
      previewKind: mimeType.startsWith("image/") ? "image" : "none",
      previewUrl: null,
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
