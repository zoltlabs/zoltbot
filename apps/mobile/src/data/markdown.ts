// A small Markdown reader for plans and request context: headings, lists, checklists, quotes,
// code fences and inline bold, italic, code and links. Enough for agent plans without a
// renderer dependency; anything else falls back to plain paragraphs.

export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type Block =
  | { type: "heading"; level: number; text: Inline[] }
  | { type: "paragraph"; text: Inline[] }
  | { type: "item"; marker: string; depth: number; checked?: boolean; text: Inline[] }
  | { type: "quote"; text: Inline[] }
  | { type: "code"; text: string }
  | { type: "rule" };

const inlinePattern =
  /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/;
export function inline(source: string): Inline[] {
  const out: Inline[] = [];
  for (const part of source.split(inlinePattern)) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      out.push({ text: part.slice(1, -1), code: true });
    else if (/^(\*\*|__).+\1$/.test(part)) out.push({ text: part.slice(2, -2), bold: true });
    else if (/^([*_]).+\1$/.test(part)) out.push({ text: part.slice(1, -1), italic: true });
    else if (/^\[[^\]]+\]\([^)]+\)$/.test(part))
      out.push({ text: part.slice(1, part.indexOf("]")) });
    else out.push({ text: part });
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: inline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(fence[1] ?? "```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: "heading",
        level: heading[1]?.length ?? 1,
        text: inline((heading[2] ?? "").replace(/\s#+\s*$/, "")),
      });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (item) {
      flush();
      const marker = item[2] ?? "-";
      blocks.push({
        type: "item",
        marker: /\d/.test(marker) ? marker.replace(")", ".") : "•",
        depth: Math.min(3, Math.floor((item[1] ?? "").replace(/\t/g, "  ").length / 2)),
        ...(item[3] ? { checked: (item[4] ?? " ").toLowerCase() === "x" } : {}),
        text: inline(item[5] ?? ""),
      });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ type: "quote", text: inline(quote[1] ?? "") });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
