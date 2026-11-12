import {
  markRecovered,
  routineActivity,
  activityLabel as sharedActivityLabel,
} from "@zoltbot/ui/chat/activity-data";
import { body, type Row } from "@zoltbot/ui/chat/types";
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
  const sources = new Map(
    markRecovered(
      [...(snapshot.entities.item ?? [])].sort((a, b) => Number(a.seq) - Number(b.seq)),
    ).map((item) => [item.id, item]),
  );
  const project = (row: TranscriptRow): TranscriptRow => ({
    ...row,
    ...(sources.has(row.id) ? { activityItem: sources.get(row.id) } : {}),
    ...(row.children ? { children: row.children.map(project) } : {}),
  });
  for (const original of rows) {
    const row = project(original);
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
  const items = rows.map(activitySource).map((item) =>
    active
      ? item
      : {
          ...item,
          body: {
            ...body(item),
            streaming: false,
            status: body(item).status === "running" ? "ok" : body(item).status,
          },
        },
  );
  return sharedActivityLabel(items);
}

function activitySource(row: TranscriptRow): Row {
  return (
    row.activityItem ?? {
      id: row.id,
      kind: row.kind,
      body: { status: row.status === "failed" ? "error" : row.status, streaming: row.streaming },
    }
  );
}

export function routineRow(row: TranscriptRow): boolean {
  // A failed subagent remains discoverable even when its parent tool succeeded.
  if (row.children?.some((child) => !routineRow(child) && child.kind === "tool")) return false;
  return routineActivity(activitySource(row));
}

export function assistantSegments(rows: TranscriptRow[]) {
  const segments: { id: string; activity: boolean; rows: TranscriptRow[] }[] = [];
  for (const row of rows) {
    const activity = routineRow(row);
    const previous = segments.at(-1);
    if (activity && previous?.activity) previous.rows.push(row);
    else segments.push({ id: row.id, activity, rows: [row] });
  }
  return segments;
}
