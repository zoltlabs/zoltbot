import type { TranscriptRow } from "./timeline.js";
import type { Snapshot } from "./transport.js";

export type ConversationEntry =
  | { kind: "row"; id: string; row: TranscriptRow }
  | { kind: "assistant"; id: string; rows: TranscriptRow[]; active: boolean };

/** Group by the saved turn, without merging messages across user input or system notices. */
export function conversation(
  rows: TranscriptRow[],
  snapshot: Snapshot,
  activeTurnId?: string,
): ConversationEntry[] {
  const turns = new Map((snapshot.entities.item ?? []).map((item) => [item.id, item.turnId]));
  const entries: ConversationEntry[] = [];
  for (const row of rows) {
    const turn = turns.get(row.id);
    const assistant = ["message", "thought", "tool", "interaction"].includes(row.kind);
    const previous = entries.at(-1);
    if (assistant && typeof turn === "string" && turn) {
      if (previous?.kind === "assistant" && previous.id === turn) previous.rows.push(row);
      else
        entries.push({ kind: "assistant", id: turn, rows: [row], active: turn === activeTurnId });
    } else entries.push({ kind: "row", id: row.id, row });
  }
  // A new turn can be running before the provider emits its first item.
  if (activeTurnId && !entries.some((entry) => entry.kind === "assistant" && entry.active))
    entries.push({ kind: "assistant", id: activeTurnId, rows: [], active: true });
  // Only the last fragment of a turn carries progress (artifacts can split fragments).
  let seenActive = false;
  for (const entry of entries.toReversed()) {
    if (entry.kind !== "assistant" || !entry.active) continue;
    if (seenActive) entry.active = false;
    seenActive = true;
  }
  return entries;
}

export function activityLabel(rows: readonly TranscriptRow[], active = false): string {
  const failed = rows.filter((row) => row.status === "failed").length;
  if (failed) return `${failed} ${failed === 1 ? "tool failed" : "tools failed"}`;
  if (active && rows.some((row) => row.kind === "tool" && row.status === "running"))
    return "Using tools…";
  const tools = rows.filter((row) => row.kind === "tool").length;
  return tools ? `Used ${tools} ${tools === 1 ? "tool" : "tools"}` : "Thought process";
}
