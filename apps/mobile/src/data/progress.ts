// C10: the agent's progress notes, placed in its chat at the time it posted them, as on the Mac.
import { chatProgressKey, readProgressNotes } from "@zoltbot/protocol";
import { chiefThreadId } from "@zoltbot/ui/chief/data";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Puts each note inside its own turn, after the last of that turn's rows made before it, so it
 * groups with the turn's other rows and never drifts past rows that have no time of their own.
 */
export function withProgress(
  snapshot: Snapshot,
  threadId: string,
  rows: TranscriptRow[],
): TranscriptRow[] {
  const notes = readProgressNotes(
    (snapshot.entities.settings ?? []).find((row) => row.key === chatProgressKey(threadId))?.value,
  );
  if (!notes.length) return rows;
  const items = new Map(
    (snapshot.entities.item ?? [])
      .filter((item) => item.threadId === threadId)
      .map((item) => [text(item.id), { turnId: text(item.turnId), at: text(item.createdAt) }]),
  );
  // Zolt's notes wear Zolt's colour, as its avatar does.
  const zolt = chiefThreadId(snapshot.entities) === threadId;
  const result = [...rows];
  const placed = new Map<string, string>();
  const turnOf = (row: TranscriptRow) =>
    row.progress ? row.turnId : items.get(row.id)?.turnId || undefined;
  const timeOf = (row: TranscriptRow) => placed.get(row.id) ?? items.get(row.id)?.at ?? "";
  for (const note of notes) {
    const own = result.flatMap((row, index) => (turnOf(row) === note.turnId ? [index] : []));
    const before = own.filter((index) => {
      const row = result[index];
      return !!row && timeOf(row) <= note.at;
    });
    // After the turn's last earlier row; else before its first; else at the end (a new turn).
    const index =
      before.length > 0
        ? (before.at(-1) ?? 0) + 1
        : own.length > 0
          ? (own[0] ?? result.length)
          : result.length;
    const id = `progress:${note.id}`;
    placed.set(id, note.at);
    result.splice(index, 0, {
      id,
      kind: "other",
      text: note.text,
      streaming: false,
      turnId: note.turnId,
      progress: zolt ? { threadId, zolt } : { threadId },
    });
  }
  return result;
}
