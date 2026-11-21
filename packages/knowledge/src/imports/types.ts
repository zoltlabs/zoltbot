// M4: what an export from another assistant gives us. Parsers never keep more than these limits.
export type ImportSource = "chatgpt" | "claude" | "gemini";

/** A fact the other assistant already saved about the owner. */
export interface ImportedMemory {
  title: string;
  body: string;
}

/** One conversation, reduced to the owner's and the assistant's text. */
export interface ImportedConversation {
  title: string;
  at: string;
  turns: { role: "user" | "assistant"; text: string }[];
}

export interface ImportedExport {
  source: ImportSource;
  memories: ImportedMemory[];
  conversations: ImportedConversation[];
}

/** The files inside an export, by path inside the ZIP (or the file name for a bare JSON). */
export type ExportFiles = ReadonlyMap<string, string>;

export const importLimits = {
  memories: 500,
  memoryChars: 1200,
  titleChars: 200,
  /** Conversations a task reads; the newest are kept. */
  conversations: 200,
  turnsPerConversation: 40,
  turnChars: 2000,
};

export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export function json(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The file whose path ends with `name`, ignoring folders and case. */
export function findFile(files: ExportFiles, ...names: string[]) {
  for (const [path, text] of files) {
    const lower = path.toLowerCase();
    if (names.some((name) => lower === name || lower.endsWith(`/${name}`))) return text;
  }
  return undefined;
}

type Row = Record<string, unknown>;
export const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === "object") : [];
export const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Newest first, capped, with each turn trimmed; empty conversations dropped. */
export function keepConversations(list: ImportedConversation[]): ImportedConversation[] {
  return list
    .map((conversation) => ({
      title: clip(conversation.title.trim() || "Untitled", importLimits.titleChars),
      at: conversation.at,
      turns: conversation.turns
        .filter((turn) => turn.text.trim())
        .slice(0, importLimits.turnsPerConversation)
        .map((turn) => ({ role: turn.role, text: clip(turn.text.trim(), importLimits.turnChars) })),
    }))
    .filter((conversation) => conversation.turns.some((turn) => turn.role === "user"))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, importLimits.conversations);
}

export function keepMemories(list: ImportedMemory[]): ImportedMemory[] {
  const seen = new Set<string>();
  const kept: ImportedMemory[] = [];
  for (const memory of list) {
    const body = clip(memory.body.trim(), importLimits.memoryChars);
    if (!body || seen.has(body)) continue;
    seen.add(body);
    const title = clip(memory.title.trim() || body.split(/[.\n]/)[0] || body, 80);
    kept.push({ title, body });
    if (kept.length >= importLimits.memories) break;
  }
  return kept;
}

/** Seconds or ISO text to ISO; empty when unknown. */
export function isoTime(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  return "";
}
