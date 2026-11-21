import type { ImportedMemory } from "./types.js";

type Row = Record<string, unknown>;
const FIELDS = ["memory", "content", "text", "value", "body", "conversations_memory"] as const;
/** Keys that wrap a list of memories; nothing else in an object is read. */
const WRAPPERS = ["memories", "memory", "project_memories", "items"] as const;

/** A long memory written as a list becomes one memory per item. */
function split(body: string): string[] {
  if (body.length <= 1200) return [body];
  const items = body
    .split(/\n(?=\s*(?:[-*•]|\d+[.)])\s)|\n{2,}/)
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  return items.length > 1 ? items : [body];
}

/**
 * Saved memories, read strictly: a list of strings, or of objects with the text in a known field,
 * possibly under a known wrapping key. Other fields, such as ids and dates, are never read.
 */
export function savedMemories(value: unknown, depth = 0): ImportedMemory[] {
  if (depth > 3 || !value) return [];
  if (typeof value === "string") return split(value).map((body) => ({ title: "", body }));
  if (Array.isArray(value)) return value.flatMap((entry) => savedMemories(entry, depth + 1));
  if (typeof value !== "object") return [];
  const row = value as Row;
  const field = FIELDS.find((key) => typeof row[key] === "string");
  const title = typeof row.title === "string" ? row.title : "";
  const own = field
    ? split(row[field] as string).map((body, index) => ({ title: index ? "" : title, body }))
    : [];
  const nested = WRAPPERS.filter(
    (key) => key !== field && row[key] && typeof row[key] === "object",
  ).flatMap((key) => {
    const inner = row[key];
    // A map of project name to memory text.
    if (
      !Array.isArray(inner) &&
      Object.values(inner as Row).every((item) => typeof item === "string")
    )
      return Object.values(inner as Row).flatMap((item) => savedMemories(item, depth + 1));
    return savedMemories(inner, depth + 1);
  });
  return [...own, ...nested];
}
