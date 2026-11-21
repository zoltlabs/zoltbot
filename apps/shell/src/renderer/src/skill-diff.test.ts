import { describe, expect, it } from "vitest";
import { foldDiff, lineDiff } from "./skill-diff";

describe("lineDiff", () => {
  it("marks added, removed and unchanged lines", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("treats Windows line endings like Unix ones", () => {
    expect(lineDiff("a\r\nb\r\n", "a\nb\n").every((line) => line.kind === "same")).toBe(true);
  });

  it("keeps the longest run of shared lines", () => {
    const diff = lineDiff("x\na\nb\nc\n", "a\nb\nc\ny\n");
    expect(diff.filter((line) => line.kind === "same").map((line) => line.text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("foldDiff", () => {
  it("folds long unchanged runs and keeps context around changes", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const folded = foldDiff(lineDiff(before, after));
    expect(folded[0]).toEqual({ kind: "skip", count: 8 });
    expect(folded.at(-1)).toEqual({ kind: "skip", count: 7 });
    expect(folded.filter((line) => line.kind !== "skip")).toHaveLength(6);
  });

  it("shows a single unchanged line instead of folding it", () => {
    const folded = foldDiff(lineDiff("a\nb\nc\nd\ne\nf\n", "A\nb\nc\nd\ne\nF\n"));
    expect(folded.some((line) => line.kind === "skip")).toBe(false);
  });
});
