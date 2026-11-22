import { describe, expect, it, vi } from "vitest";
import {
  loadAttachmentPreview,
  previewProblem,
  type SaveFile,
  savedName,
} from "./attachment-preview";

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
    expect(previewProblem(new Error("attachment_preview_too_large"))).toMatch(
      /too big for your phone/,
    );
    expect(previewProblem(new Error("attachment_changed"))).toMatch(/Try again/);
    expect(previewProblem(new Error("nope"))).toMatch(/Open it on your Mac/);
  });
});

describe("PDFs, videos and SVG", () => {
  const bytes = "0123456789abcdefghij"; // 20 bytes, 28 base64 characters
  const encoded = btoa(bytes);
  const pieces = (size = bytes.length, shift = 0) =>
    vi.fn(async (_method: string, params: Record<string, unknown>) => {
      const offset = Number(params.offset ?? 0);
      const end = Math.min(encoded.length, offset + 12);
      return {
        kind: "pdf",
        name: "Q3 report.pdf",
        mime: "application/pdf",
        size,
        stamp: "20:1700:42",
        data: encoded.slice(offset + shift, end),
        next: end < encoded.length ? end : null,
      };
    });
  function memory() {
    const files: Record<string, string> = {};
    const removed: string[] = [];
    const save: SaveFile = async (name) => {
      files[name] = "";
      return {
        uri: `file:///cache/${name}`,
        append: (data) => {
          files[name] += data;
        },
        remove: () => removed.push(name),
      };
    };
    return { files, removed, save };
  }

  it("appends each piece to a cache file and reports progress", async () => {
    const { files, save } = memory();
    const progress = vi.fn();
    const preview = await loadAttachmentPreview(pieces(), target, save, progress);
    expect(preview).toEqual({
      kind: "pdf",
      name: "Q3 report.pdf",
      mime: "application/pdf",
      size: 20,
      uri: "file:///cache/20170042-Q3_report.pdf",
    });
    expect(atob(files["20170042-Q3_report.pdf"] ?? "")).toBe(bytes);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it("removes the file when pieces don't line up, and refuses files over the cap", async () => {
    const { removed, save } = memory();
    await expect(loadAttachmentPreview(pieces(20, 4), target, save)).rejects.toThrow(
      "attachment_changed",
    );
    expect(removed).toEqual(["20170042-Q3_report.pdf"]);
    await expect(loadAttachmentPreview(pieces(26 * 1024 * 1024), target, save)).rejects.toThrow(
      "attachment_preview_too_large",
    );
    await expect(loadAttachmentPreview(pieces(), target)).rejects.toThrow(
      "attachment_preview_unavailable",
    );
  });

  it("keeps the extension and drops anything unsafe from the saved name", () => {
    expect(savedName("../../etc/passwd.mp4", "1:2:3")).toBe("123-.._.._etc_passwd.mp4");
    expect(savedName("", "s")).toBe("s-file");
  });

  it("returns SVG as markup", async () => {
    const call = vi.fn(async () => ({
      kind: "svg",
      name: "chart.svg",
      mime: "image/svg+xml",
      size: 12,
      stamp: "s",
      data: "<svg></svg>",
      next: null,
    }));
    expect(await loadAttachmentPreview(call, target)).toEqual({
      kind: "svg",
      name: "chart.svg",
      xml: "<svg></svg>",
    });
  });
});
