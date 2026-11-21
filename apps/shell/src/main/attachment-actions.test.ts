import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AttachmentActionHost, runAttachmentAction } from "./attachment-actions";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "attachment-actions-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function host(savePath?: string) {
  return {
    window: () => null,
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => ""),
    showSaveDialog: vi.fn(async () =>
      savePath ? { canceled: false, filePath: savePath } : { canceled: true },
    ),
    writeImage: vi.fn((bytes: Buffer) => bytes.length > 0),
  } satisfies AttachmentActionHost;
}

it("saves a copy where the owner picks, and nothing when they cancel", async () => {
  const picture = join(dir, "chart.png");
  await writeFile(picture, "png-bytes");
  const target = join(dir, "saved.png");
  const saving = host(target);
  const input = { attachmentId: "item:a:0", action: "save" } as const;
  expect(await runAttachmentAction(saving, input, { path: picture, mimeType: "image/png" })).toBe(
    true,
  );
  expect(saving.showSaveDialog).toHaveBeenCalledWith(
    null,
    expect.objectContaining({ defaultPath: "chart.png" }),
  );
  expect(await readFile(target, "utf8")).toBe("png-bytes");
  const photo = { bytes: new Uint8Array([1, 2]), mimeType: "image/jpeg" };
  const cancelled = host();
  expect(await runAttachmentAction(cancelled, input, photo)).toBe(false);
  expect(cancelled.showSaveDialog).toHaveBeenCalledWith(
    null,
    expect.objectContaining({ defaultPath: "Photo.jpg" }),
  );
});

it("copies a picture from a file or a sent photo", async () => {
  const actions = host();
  const input = { attachmentId: "item:a:0", action: "copy" } as const;
  await runAttachmentAction(actions, input, { bytes: new Uint8Array([7]), mimeType: "image/png" });
  expect(actions.writeImage).toHaveBeenCalledWith(Buffer.from([7]));
  await expect(
    runAttachmentAction(actions, input, { bytes: new Uint8Array(), mimeType: "image/png" }),
  ).rejects.toThrow("Can't copy this picture.");
});

it("opens only documents from a chat, and needs a file for Finder", async () => {
  const actions = host();
  const app = { path: join(dir, "Tool.app"), mimeType: "application/octet-stream" };
  await expect(
    runAttachmentAction(actions, { attachmentId: "item:a:0", action: "open" }, app),
  ).rejects.toThrow("Only documents open from a chat.");
  expect(actions.openPath).not.toHaveBeenCalled();
  // A draft the owner picked on this Mac still opens.
  await runAttachmentAction(actions, { attachmentId: "draft-1", action: "open" }, app);
  expect(actions.openPath).toHaveBeenCalledWith(app.path);
  await expect(
    runAttachmentAction(
      actions,
      { attachmentId: "item:a:1", action: "reveal" },
      { bytes: new Uint8Array([1]), mimeType: "image/png" },
    ),
  ).rejects.toThrow("Attachment was not found.");
  await expect(
    runAttachmentAction(actions, { attachmentId: "x", action: "reveal" }, undefined),
  ).rejects.toThrow("Attachment was not found.");
});

it("copies and saves only pictures from a chat, and never saves a file onto itself", async () => {
  const actions = host(join(dir, "notes.txt"));
  const text = { path: join(dir, "notes.txt"), mimeType: "text/plain" };
  await writeFile(text.path, "keep");
  for (const action of ["copy", "save"] as const)
    await expect(
      runAttachmentAction(actions, { attachmentId: "item:a:0", action }, text),
    ).rejects.toThrow("Only pictures can be copied or saved from here.");
  const picture = join(dir, "same.png");
  await writeFile(picture, "png-bytes");
  const onto = host(picture);
  await runAttachmentAction(
    onto,
    { attachmentId: "item:a:0", action: "save" },
    { path: picture, mimeType: "image/png" },
  );
  expect(await readFile(picture, "utf8")).toBe("png-bytes");
});
