import { describe, expect, it, vi } from "vitest";
import { loadAttachmentPreview, previewProblem } from "./attachment-preview";

const target = { threadId: "t", itemId: "i", part: 1 };

describe("loadAttachmentPreview", () => {
  it("reads a ZIP's file list", async () => {
    const listing = { entries: [{ name: "a.txt", size: 4 }], files: 1, unpacked: 4 };
    const call = vi.fn(async () => ({
      kind: "zip",
      name: "bundle.zip",
      mime: "application/zip",
      size: 60,
      stamp: "s",
      data: JSON.stringify(listing),
      next: null,
    }));
    expect(await loadAttachmentPreview(call, target)).toEqual({
      kind: "zip",
      name: "bundle.zip",
      listing,
    });
  });

  it("joins pieces with the first piece's stamp and reads CSV as a table", async () => {
    const text = "a,b\n1,2\n";
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      const offset = Number(params.offset ?? 0);
      const end = Math.min(text.length, offset + 3);
      return {
        kind: "csv",
        name: "x.csv",
        mime: "text/csv",
        size: text.length,
        stamp: "s1",
        data: text.slice(offset, end),
        next: end < text.length ? end : null,
      };
    });
    const preview = await loadAttachmentPreview(call, target);
    expect(preview).toEqual({
      kind: "table",
      name: "x.csv",
      table: { header: ["a", "b"], rows: [["1", "2"]], total: 1 },
    });
    expect(call.mock.calls.slice(1).every(([, p]) => p.stamp === "s1")).toBe(true);
  });

  it("builds a data URI only for picture types it knows", async () => {
    const piece = (mime: string) => async () => ({
      kind: "image",
      name: "p.png",
      mime,
      size: 5,
      stamp: "s",
      data: "aGVsbG8=",
      next: null,
    });
    expect(await loadAttachmentPreview(piece("image/png"), target)).toEqual({
      kind: "image",
      name: "p.png",
      uri: "data:image/png;base64,aGVsbG8=",
    });
    await expect(loadAttachmentPreview(piece("image/svg+xml"), target)).rejects.toThrow(
      "attachment_preview_unavailable",
    );
  });

  it("stops when the pieces don't line up", async () => {
    const call = async () => ({
      kind: "text",
      name: "a.txt",
      mime: "text/plain",
      size: 10,
      stamp: "s",
      data: "ab",
      next: 7,
    });
    await expect(loadAttachmentPreview(call, target)).rejects.toThrow("attachment_changed");
  });

  it("explains each failure in words", () => {
    expect(previewProblem(new Error("attachment_preview_too_large"))).toMatch(/over 5 MB/);
    expect(previewProblem(new Error("attachment_changed"))).toMatch(/Try again/);
    expect(previewProblem(new Error("nope"))).toMatch(/Open it on your Mac/);
  });
});
