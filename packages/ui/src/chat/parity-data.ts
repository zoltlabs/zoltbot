import { type Row, text } from "./types.js";

export interface BackgroundTask {
  id: string;
  kind: string;
  description: string;
  state: "running" | "completed" | "failed" | "stopped";
  summary?: string;
}
export function backgroundTasks(session: Row | undefined): BackgroundTask[] {
  if (!session || !Array.isArray(session.background)) return [];
  return (session.background as unknown[]).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Row;
    const state = ["running", "completed", "failed", "stopped"].includes(text(row.state))
      ? (text(row.state) as BackgroundTask["state"])
      : undefined;
    if (!text(row.id) || !state) return [];
    return [
      {
        id: text(row.id),
        kind: text(row.kind) || "other",
        description: text(row.description) || "Background task",
        state,
        ...(text(row.summary) ? { summary: text(row.summary) } : {}),
      },
    ];
  });
}
export interface RewindPreview {
  canRewind: boolean;
  files: string[];
  insertions?: number;
  deletions?: number;
  error?: string;
}
export function rewindPreview(value: unknown): RewindPreview {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const count = (key: string) =>
    typeof row[key] === "number" && Number.isInteger(row[key]) && (row[key] as number) >= 0
      ? { [key]: row[key] as number }
      : {};
  return {
    canRewind: row.canRewind === true,
    files: Array.isArray(row.files)
      ? row.files.filter((file): file is string => typeof file === "string").slice(0, 500)
      : [],
    ...count("insertions"),
    ...count("deletions"),
    ...(typeof row.error === "string" && row.error ? { error: row.error } : {}),
  };
}
