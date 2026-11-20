// C5: the chat's hidden messages, as on the Mac. The agent still has them; only the display folds.
import { messageHiddenKey, readHiddenMessages } from "@zoltbot/protocol";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";

export function hiddenIds(snapshot: Snapshot, threadId: string): Set<string> {
  const row = (snapshot.entities.settings ?? []).find((r) => r.key === messageHiddenKey(threadId));
  return new Set(readHiddenMessages(row?.value));
}

/** Rows with their hidden flag set. */
export function withHidden(
  snapshot: Snapshot,
  threadId: string,
  rows: TranscriptRow[],
): TranscriptRow[] {
  const hidden = hiddenIds(snapshot, threadId);
  if (!hidden.size) return rows;
  return rows.map((row) => (hidden.has(row.id) ? { ...row, hidden: true } : row));
}
