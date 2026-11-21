// C8: reactions from the owner and the chat's agent, as on the Mac.
import { messageReactionsKey, reactionsByItem } from "@zoltbot/protocol";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";

/** Rows with their reactions set. */
export function withReactions(
  snapshot: Snapshot,
  threadId: string,
  rows: TranscriptRow[],
): TranscriptRow[] {
  const row = (snapshot.entities.settings ?? []).find(
    (r) => r.key === messageReactionsKey(threadId),
  );
  const byItem = reactionsByItem(row?.value);
  if (!byItem.size) return rows;
  return rows.map((r) => {
    const reactions = byItem.get(r.id);
    return reactions ? { ...r, reactions } : r;
  });
}
