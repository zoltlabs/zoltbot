import { describe, expect, it } from "vitest";
import { countLines, diffLines, diffStats, lineDiff, trimContext } from "./diff-data.js";
import {
  collapseLines,
  images,
  linkParts,
  locations,
  matchLines,
  outputText,
  stripAnsi,
  toolKind,
  toolSummary,
} from "./tool-data.js";

describe("diff line counting", () => {
  it("counts unified patch lines without headers", () => {
    const lines = diffLines({
      path: "a.ts",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n+extra\n",
    });
    expect(countLines(lines)).toEqual({ added: 2, removed: 1 });
    expect(lines.find((line) => line.kind === "add")).toMatchObject({ text: "new", new: 2 });
    expect(lines.filter((line) => line.kind === "meta")).toHaveLength(2);
  });
  it("diffs before and after text with a common subsequence", () => {
    const lines = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(countLines(lines)).toEqual({ added: 2, removed: 1 });
    expect(lines.map((line) => line.kind)).toEqual(["ctx", "del", "add", "ctx", "ctx", "add"]);
  });
  it("treats a new file as all additions and falls back on large inputs", () => {
    expect(countLines(lineDiff("", "x\ny"))).toEqual({ added: 2, removed: 0 });
    const big = lineDiff("a\nb\nc", "d\ne\nf", 1);
    expect(countLines(big)).toEqual({ added: 3, removed: 3 });
  });
  it("trims unchanged context and sums across files", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const trimmed = trimContext(lineDiff(before, after));
    expect(trimmed.filter((line) => line.kind === "ctx")).toHaveLength(6);
    expect(trimmed[0]).toMatchObject({ kind: "hunk", text: "7 unchanged lines" });
    expect(
      diffStats([
        { path: "a", before, after },
        { path: "b", patch: "@@ -1 +1 @@\n-x\n+y" },
      ]),
    ).toEqual({ added: 2, removed: 2 });
  });
});

describe("tool fields", () => {
  it("summarizes by title, then location, never by the provider's kind guesses", () => {
    expect(toolSummary({ title: "npm test", name: "Bash" })).toBe("npm test");
    expect(toolSummary({ locations: [{ path: "src/a.ts", line: 4 }] })).toBe("src/a.ts:4");
    expect(toolSummary({ kind: "search" })).toBe("Search");
    expect(toolSummary({ name: "Bash", input: { command: "pnpm test\n--watch" } })).toBe(
      "pnpm test",
    );
    expect(toolSummary({ name: "Read", input: { file_path: "src/app.ts" } })).toBe("src/app.ts");
    expect(toolKind({ kind: "unknown" })).toBe("other");
    expect(locations({ locations: [{ path: "" }, { path: "x", line: "2" }, 4] })).toEqual([
      { path: "x" },
    ]);
  });
  it("strips terminal escapes and joins text content blocks", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m \u001b]0;title\u0007ok")).toBe("red ok");
    expect(
      outputText([
        { type: "text", text: "\u001b[1mone\u001b[22m" },
        { type: "content", content: { type: "text", text: "two" } },
      ]),
    ).toBe("one\ntwo");
    expect(outputText({ exitCode: 1 })).toContain('"exitCode": 1');
    expect(outputText([{ type: "image", mimeType: "image/png", data: "AAAA" }])).toBe("");
  });
  it("renders only inline raster images", () => {
    expect(
      images([
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
        { type: "image", url: "https://example.invalid/a.png" },
        { type: "image", mimeType: "image/png", data: "not base64!" },
      ]),
    ).toEqual(["data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,AAAA"]);
  });
  it("collapses long output and caps matches", () => {
    const long = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    expect(collapseLines(long)).toMatchObject({ hidden: 28 });
    expect(collapseLines("a\nb").hidden).toBe(0);
    const matches = matchLines(Array.from({ length: 60 }, (_, i) => `f${i}`).join("\n"));
    expect(matches.lines).toHaveLength(50);
    expect(matches.more).toBe(10);
  });
  it("links only http and https URLs and drops trailing punctuation", () => {
    expect(linkParts("See https://example.com/a. Or javascript:alert(1)")).toEqual([
      { text: "See " },
      { text: "https://example.com/a", href: "https://example.com/a" },
      { text: ". Or javascript:alert(1)" },
    ]);
  });
});

it("summarizes a team_message call by what was sent and to whom", () => {
  expect(
    toolSummary({
      name: "mcp__zoltbot__team_message",
      input: { key: "k", text: "Which layout?", to: "Design", question: true },
    }),
  ).toBe("Question to Design: Which layout?");
  expect(
    toolSummary({ name: "mcp__zoltbot__team_message", input: { key: "k", text: "Done" } }),
  ).toBe("Update to your manager: Done");
  expect(
    toolSummary({
      name: "mcp__zoltbot__team_message",
      input: { key: "k", text: "Two-column", replyTo: "msg-1" },
    }),
  ).toBe("Reply: Two-column");
});
