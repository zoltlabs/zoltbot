// What the window can do with an attachment, by id: open it in its app, show it in Finder, save
// a copy (C17's Save…), or copy a picture to the clipboard (C17's Copy). Main resolves the id; the
// window never names a path.
import { constants } from "node:fs";
import { copyFile, open, realpath, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { filePreviewKind } from "@zoltbot/protocol";

const isPicture = (path: string) => ["image", "svg"].includes(filePreviewKind(path));

import type { BrowserWindow, SaveDialogOptions } from "electron";
import type { OpenAttachmentInput } from "../shared/ipc";
import type { AttachmentSource } from "../zolt/sent-attachments";

export interface AttachmentActionHost {
  window: () => BrowserWindow | null;
  showItemInFolder: (path: string) => void;
  openPath: (path: string) => Promise<string>;
  showSaveDialog: (
    window: BrowserWindow | null,
    options: SaveDialogOptions,
  ) => Promise<{ canceled: boolean; filePath?: string }>;
  writeImage: (bytes: Buffer) => boolean;
}

/** The largest picture Copy reads into main. */
const COPY_BYTES = 50 * 1024 * 1024;

/** A picture file's bytes, read without blocking on a pipe or device. */
async function readPicture(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > COPY_BYTES) throw new Error("Can't copy this picture.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Runs one action. Save returns false when the owner cancels the dialog. */
export async function runAttachmentAction(
  host: AttachmentActionHost,
  input: OpenAttachmentInput,
  source: AttachmentSource | undefined,
): Promise<boolean> {
  if (!source) throw new Error("Attachment was not found.");
  const path = "path" in source ? source.path : undefined;
  const inline = "bytes" in source ? source.bytes : undefined;
  // A sent message can name any path, so Copy and Save act only on pictures.
  const picture = !path || !input.attachmentId.startsWith("item:") || isPicture(path);
  if ((input.action === "copy" || input.action === "save") && !picture)
    throw new Error("Only pictures can be copied or saved from here.");
  if (input.action === "copy") {
    const bytes = path ? await readPicture(path) : Buffer.from(inline ?? []);
    if (!host.writeImage(bytes)) throw new Error("Can't copy this picture.");
    return true;
  }
  if (input.action === "save") {
    const name = path ? basename(path) : `Photo${EXTENSIONS[source.mimeType] ?? ""}`;
    const result = await host.showSaveDialog(host.window(), {
      defaultPath: name,
      ...(extname(name)
        ? {
            filters: [
              { name: extname(name).slice(1).toUpperCase(), extensions: [extname(name).slice(1)] },
            ],
          }
        : {}),
    });
    if (result.canceled || !result.filePath) return false;
    // Saving over the original would truncate it; it is already there.
    const same =
      path &&
      (await realpath(result.filePath).catch(() => result.filePath)) ===
        (await realpath(path).catch(() => path));
    if (same) return true;
    if (path) await copyFile(path, result.filePath);
    else if (inline) await writeFile(result.filePath, inline);
    return true;
  }
  if (!path) throw new Error("Attachment was not found.");
  if (input.action === "reveal") {
    host.showItemInFolder(path);
    return true;
  }
  // A sent message can name any path, so only documents with a preview open in their app.
  if (input.attachmentId.startsWith("item:") && filePreviewKind(path) === "none")
    throw new Error("Only documents open from a chat.");
  const error = await host.openPath(path);
  if (error) throw new Error(error);
  return true;
}
