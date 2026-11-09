import { type Row, text } from "../types.js";

/** Normalized tool fields only (I4): renderers never branch on a provider's tool name. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "mode"
  | "agent"
  | "other";
const kinds = new Set<string>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "mode",
  "agent",
  "other",
]);
export const toolKind = (value: Row): ToolKind =>
  kinds.has(text(value.kind)) ? (text(value.kind) as ToolKind) : "other";

export const kindLabels: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  mode: "Mode",
  agent: "Subagent",
  other: "Tool",
};
export const kindIcons: Record<ToolKind, string> = {
  read: "FileText",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Terminal",
  think: "Brain",
  fetch: "Globe",
  mode: "Shield",
  agent: "Bot",
  other: "Tool",
};

export interface ToolLocation {
  path: string;
  line?: number;
}
export function locations(value: Row): ToolLocation[] {
  if (!Array.isArray(value.locations)) return [];
  const result: ToolLocation[] = [];
  for (const entry of value.locations as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Row;
    if (typeof row.path !== "string" || !row.path) continue;
    result.push({
      path: row.path,
      ...(typeof row.line === "number" && Number.isFinite(row.line) ? { line: row.line } : {}),
    });
  }
  return result;
}
/** The one line summary: the adapter's title first, then the first location, then a kind label. */
/** "Question to Design: …" for a team_message call, so the sender sees what it sent and where. */
export function teamMessageSummary(value: Row): string | undefined {
  if (!/(?:^|__|\.)team_message$/.test(text(value.name))) return undefined;
  const input = value.input && typeof value.input === "object" ? (value.input as Row) : {};
  const to = text(input.to);
  if (input.replyTo) return `Reply${to ? ` to ${to}` : ""}: ${text(input.text)}`;
  return `${input.question === true ? "Question" : "Update"} to ${to || "your manager"}: ${text(input.text)}`;
}
export function toolSummary(value: Row): string {
  const message = teamMessageSummary(value);
  if (message) return message;
  const title = text(value.title).trim();
  if (title) return title;
  const first = locations(value)[0];
  if (first) return first.line ? `${first.path}:${first.line}` : first.path;
  // Without a title, say what the tool was pointed at: the command, file, search or page.
  const input = value.input && typeof value.input === "object" ? (value.input as Row) : {};
  for (const key of ["command", "file_path", "path", "pattern", "query", "url"]) {
    const target = text(input[key]).trim();
    if (target) return target.split("\n")[0] as string;
  }
  return text(value.name) || kindLabels[toolKind(value)];
}

const ansi =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences are control characters.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
export const stripAnsi = (value: string) => value.replace(ansi, "");

function blockText(block: unknown): string | undefined {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return undefined;
  const row = block as Row;
  if (row.type === "text" && typeof row.text === "string") return row.text;
  if (row.type === "content" && row.content) return blockText(row.content);
  return undefined;
}
/** Plain text of a tool's output or content blocks; structured values fall back to JSON. */
export function outputText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return stripAnsi(value);
  if (Array.isArray(value)) {
    const parts = value.map(blockText);
    if (parts.every((part) => part !== undefined)) return stripAnsi(parts.join("\n"));
    const textual = parts.filter((part): part is string => part !== undefined);
    if (textual.length) return stripAnsi(textual.join("\n"));
  } else {
    const single = blockText(value);
    if (single !== undefined) return stripAnsi(single);
  }
  if (Array.isArray(value) && value.every((block) => imageSource(block))) return "";
  return JSON.stringify(value, null, 2) ?? "";
}

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Only inline base64 images of a known raster type render; remote image URLs never load. */
export function imageSource(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const row = block as Row;
  if (row.type !== "image") return undefined;
  const source = row.source && typeof row.source === "object" ? (row.source as Row) : row;
  const mime = text(source.mimeType) || text(source.media_type) || text(source.mediaType);
  const data = text(source.data);
  if (!imageTypes.has(mime) || !data || data.length > 8_000_000) return undefined;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return undefined;
  return `data:${mime};base64,${data.replace(/\s/g, "")}`;
}
export function images(...values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const blocks = Array.isArray(value) ? value : [value];
    for (const block of blocks) {
      const direct = imageSource(block);
      if (direct) result.push(direct);
      else if (block && typeof block === "object" && (block as Row).type === "content") {
        const nested = imageSource((block as Row).content);
        if (nested) result.push(nested);
      }
    }
  }
  return result.slice(0, 12);
}

export interface CollapsedText {
  shown: string;
  hidden: number;
}
/** Long output keeps its head visible and reports how many lines are behind "Show all". */
export function collapseLines(value: string, keep = 12): CollapsedText {
  const lines = value.replace(/\n+$/, "").split("\n");
  if (lines.length <= keep + 2) return { shown: lines.join("\n"), hidden: 0 };
  return { shown: lines.slice(0, keep).join("\n"), hidden: lines.length - keep };
}

/** Lines of search output, deduplicated and capped for display. */
export function matchLines(value: string, limit = 50): { lines: string[]; more: number } {
  const lines = value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return { lines: lines.slice(0, limit), more: Math.max(0, lines.length - limit) };
}

/** Splits text into plain parts and http(s) links, which open through the desktop boundary. */
export function linkParts(value: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const index = match.index ?? 0;
    const href = match[0].replace(/[.,;:!?]+$/, "");
    if (index > last) parts.push({ text: value.slice(last, index) });
    parts.push({ text: href, href });
    last = index + href.length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}
export const isWebUrl = (value: string) => /^https?:\/\/[^\s]+$/i.test(value.trim());
