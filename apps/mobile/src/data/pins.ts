// C4: the chat's pinned messages, as on the Mac: one synced settings row per chat.
import { messagePinsKey, readMessagePins } from "@zoltbot/protocol";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";

export function storedPins(snapshot: Snapshot, threadId: string): unknown {
  return (snapshot.entities.settings ?? []).find((row) => row.key === messagePinsKey(threadId))
    ?.value;
}

/** Pinned rows still in the chat, newest pin first. */
export function pinnedRows(
  snapshot: Snapshot,
  threadId: string,
  rows: TranscriptRow[],
): TranscriptRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return readMessagePins(storedPins(snapshot, threadId)).flatMap((pin) => {
    const row = byId.get(pin.itemId);
    return row && !row.aside && !row.hidden && row.text.trim() ? [row] : [];
  });
}

/** Messages that can be pinned, as on the Mac: settled words of yours or the agent's. */
export const pinnable = (row: TranscriptRow) =>
  (row.kind === "user" || row.kind === "message") &&
  !!row.turnId &&
  !row.aside &&
  !row.queued &&
  !row.streaming &&
  !!row.text.trim();
