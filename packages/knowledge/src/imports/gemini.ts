// M4: Gemini's activity from a Google Takeout export (My Activity / Gemini Apps / MyActivity.json).
import {
  type ExportFiles,
  type ImportedExport,
  isoTime,
  json,
  keepConversations,
  rows,
  str,
} from "./types.js";

const PROMPTED = /^Prompted\s+/i;
const char = (code: number) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "");
const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => char(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => char(Number(dec)))
    .replace(/&amp;/g, "&");

function activity(files: ExportFiles) {
  for (const [path, text] of files) {
    const lower = path.toLowerCase();
    if (lower.endsWith("myactivity.json") && (lower.includes("gemini") || files.size === 1))
      return json(text);
  }
  return undefined;
}

/** Each prompt is one short conversation; Takeout doesn't group them. */
export function parseGemini(files: ExportFiles): ImportedExport {
  const conversations = rows(activity(files))
    // Takeout in other languages words the prefix differently; a prompt with a reply still counts.
    .filter((row) => PROMPTED.test(str(row.title)) || rows(row.safeHtmlItem).length > 0)
    .map((row) => {
      const prompt = str(row.title).replace(PROMPTED, "");
      const reply = rows(row.safeHtmlItem)
        .map((item) => stripHtml(str(item.html)))
        .join("\n");
      return {
        title: prompt.slice(0, 80),
        at: isoTime(row.time),
        turns: [
          { role: "user" as const, text: prompt },
          ...(reply.trim() ? [{ role: "assistant" as const, text: reply }] : []),
        ],
      };
    });
  return { source: "gemini", memories: [], conversations: keepConversations(conversations) };
}
