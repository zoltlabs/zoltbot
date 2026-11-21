// C18: the composer attaches files up to 100 MB; one over that attaches nothing in its batch.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkAttachmentSize, DraftStore } from "./draft-store";

const MB = 1024 * 1024;

it("names a file over 100 MB and attaches none of its batch", () => {
  const drafts = new DraftStore();
  expect(() => checkAttachmentSize("/w/clip.mp4", 100 * MB)).not.toThrow();
  expect(() =>
    drafts.addAll([
      { path: "/w/ok.zip", size: 10 * MB },
      { path: "/w/recording.mov", size: 100 * MB + 1 },
    ]),
  ).toThrow("recording.mov is over 100 MB, so no files were attached.");
  const [zip, video, svg] = drafts.addAll([
    { path: "/w/site.zip", size: 99 * MB },
    { path: "/w/clip.mp4", size: 100 * MB },
    { path: "/w/logo.svg", size: 900 },
  ]);
  expect([zip?.previewKind, video?.previewKind, svg?.previewKind]).toEqual(["zip", "video", "svg"]);
  expect(zip?.mimeType).toBe("application/zip");
});

it("refuses pasted bytes over 100 MB before writing them", async () => {
  const folder = await mkdtemp(join(tmpdir(), "draft-limit-"));
  try {
    const big = { byteLength: 100 * MB + 1 } as Uint8Array;
    await expect(new DraftStore().addBytes(folder, "paste.png", big)).rejects.toThrow(
      "paste.png is over 100 MB, so it wasn't attached.",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
