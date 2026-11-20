// C1: the chat's queue in send order, for Move up / Move down and for showing queued messages
// in that order.
import { queueOrderKey } from "@zoltbot/protocol";
import type { Snapshot } from "./transport.js";
import type { TranscriptRow } from "./view.js";

/** Ids of the thread's queued messages, first to be sent first. */
export function queuedIds(snapshot: Snapshot, threadId: string): string[] {
  return (snapshot.entities.item ?? [])
    .filter(
      (row) =>
        row.threadId === threadId &&
        row.kind === "user" &&
        (row.body as { queueState?: unknown } | undefined)?.queueState === "queued",
    )
    .sort((a, b) => queueOrderKey(a) - queueOrderKey(b) || Number(a.seq) - Number(b.seq))
    .map((row) => String(row.id));
}

/** The rows with the queued ones put in queue order, in the places queued rows already hold. */
export function inQueueOrder(rows: TranscriptRow[], order: readonly string[]): TranscriptRow[] {
  const queued = new Map(rows.filter((row) => row.queued).map((row) => [row.id, row]));
  const sorted = order.flatMap((id) => queued.get(id) ?? []);
  if (sorted.length !== queued.size) return rows;
  let next = 0;
  return rows.map((row) => (row.queued ? (sorted[next++] as TranscriptRow) : row));
}

/**
 * Whether Edit can put the whole queued message back in the composer: the owner's own words,
 * only text, with no artifact target or output mode the composer can't carry.
 */
export function editableQueued(snapshot: Snapshot, id: string): boolean {
  const body = (snapshot.entities.item ?? []).find((row) => row.id === id)?.body as
    | Record<string, unknown>
    | undefined;
  const input = Array.isArray(body?.input) ? (body.input as { type?: unknown }[]) : [];
  return (
    !!body &&
    !body.origin &&
    !body.artifactTarget &&
    !body.outputMode &&
    input.every((part) => part.type === "text")
  );
}

/** `ids` with `id` moved to index `to`, or null when that changes nothing or is out of range. */
export function moved(ids: readonly string[], id: string, to: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || to === from) return null;
  const next = ids.filter((other) => other !== id);
  next.splice(to, 0, id);
  return next;
}
