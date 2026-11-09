import { type ImportItem, ImportItemSchema, parse } from "@zoltbot/protocol";
import { record } from "./doctor-data.js";

export type ImportPreview = { id: string; items: ImportItem[] };
export function importPreview(value: unknown): ImportPreview {
  const data = record(value);
  if (
    typeof data.previewId !== "string" ||
    !data.previewId ||
    !Array.isArray(data.items) ||
    data.items.length > 10000
  )
    throw new Error("invalid_import_preview");
  const items = data.items.map((item) => parse(ImportItemSchema, item));
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("invalid_import_preview");
  return { id: data.previewId, items };
}
export function selectedImportIds(preview: ImportPreview, selected: ReadonlySet<string>): string[] {
  const available = new Set(preview.items.map((item) => item.id));
  if ([...selected].some((id) => !available.has(id))) throw new Error("unknown_import_item");
  return [...selected].sort();
}
export const importKind = (item: ImportItem) =>
  item.kind === "mcp"
    ? "MCP server"
    : item.kind === "session"
      ? "Native session link"
      : item.path
        ? "Project"
        : "Project hint";
