import { describe, expect, it } from "vitest";
import { fileMimeType, filePreviewKind, isProviderImage, parseDelimited } from "./file-preview.js";

describe("filePreviewKind", () => {
  it("names each previewable kind by extension, ignoring case and folders", () => {
    expect(filePreviewKind("/tmp/work/Report.CSV")).toBe("csv");
    expect(filePreviewKind("data.tsv")).toBe("tsv");
    expect(filePreviewKind("README.md")).toBe("markdown");
    expect(filePreviewKind("logo.svg")).toBe("svg");
    expect(filePreviewKind("demo.mp4")).toBe("video");
    expect(filePreviewKind("photo.jpeg")).toBe("image");
    expect(filePreviewKind("notes.txt")).toBe("text");
    expect(filePreviewKind("paper.pdf")).toBe("pdf");
  });

  it("previews nothing it can't name", () => {
    expect(filePreviewKind("archive.tar.gz")).toBe("none");
    expect(filePreviewKind("Makefile")).toBe("none");
    expect(filePreviewKind(".csv")).toBe("none");
  });

  it("sends SVG to the agent as a file, not a picture", () => {
    expect(isProviderImage("logo.svg")).toBe(false);
    expect(isProviderImage("logo.png")).toBe(true);
    expect(fileMimeType("logo.svg")).toBe("image/svg+xml");
    expect(fileMimeType("x.unknown")).toBe("application/octet-stream");
  });
});

describe("parseDelimited", () => {
  it("reads quoted cells with delimiters, quotes and line breaks", () => {
    const result = parseDelimited('name,note\r\n"Ada, L.","said ""hi""\nthen left"\nBob,\n', ",");
    expect(result.header).toEqual(["name", "note"]);
    expect(result.rows).toEqual([
      ["Ada, L.", 'said "hi"\nthen left'],
      ["Bob", ""],
    ]);
    expect(result.total).toBe(2);
  });

  it("reads TSV and drops a byte order mark", () => {
    const result = parseDelimited("﻿a\tb\n1\t2", "\t");
    expect(result.header).toEqual(["a", "b"]);
    expect(result.rows).toEqual([["1", "2"]]);
  });

  it("keeps the first rows and counts the rest", () => {
    const lines = ["n", ...Array.from({ length: 1200 }, (_, i) => String(i))].join("\n");
    const result = parseDelimited(lines, ",", 500);
    expect(result.rows).toHaveLength(500);
    expect(result.rows.at(-1)).toEqual(["499"]);
    expect(result.total).toBe(1200);
  });

  it("counts rows past the limit even when a cell holds a bare quote", () => {
    const text = `size,n\n1,1\n2,2\n12" pipe,3\n4,4\n"5\n5",5\n`;
    expect(parseDelimited(text, ",", 1)).toMatchObject({ rows: [["1", "1"]], total: 5 });
  });

  it("trims very long cells and very wide rows", () => {
    const wide = Array.from({ length: 300 }, (_, i) => `c${i}`).join(",");
    const result = parseDelimited(`${wide}\n${"x".repeat(5000)}`, ",");
    expect(result.header).toHaveLength(200);
    expect(result.rows[0]?.[0]).toHaveLength(2000);
  });

  it("skips blank lines and handles empty input", () => {
    expect(parseDelimited("a\n\n1\n\n", ",")).toEqual({ header: ["a"], rows: [["1"]], total: 1 });
    expect(parseDelimited("", ",")).toEqual({ header: [], rows: [], total: 0 });
  });
});
