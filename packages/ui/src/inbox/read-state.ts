import { useEffect, useRef } from "react";
import type { ChatConnection, Row } from "../chat/types.js";
import { text } from "../chat/types.js";

/**
 * Unread now lives on the thread so every device agrees. Until each device has synced once,
 * a chat seen here but not yet recorded on the Mac still counts as seen.
 */
export function mergeSeen(seen: Record<string, string>, threads: Row[] | undefined) {
  const merged = { ...seen };
  for (const thread of threads ?? []) {
    const id = text(thread.id),
      read = text(thread.lastReadAt),
      wakeUnread = text(thread.wakeUnreadAt);
    if (read && read > (merged[id] ?? "")) merged[id] = read;
    if (wakeUnread && wakeUnread > read && (merged[id] ?? "") < wakeUnread) {
      if (read) merged[id] = read;
      else delete merged[id];
    }
  }
  return merged;
}

/** Records a read on the thread when this device saw it later than the thread knows. */
export function markRead(connection: ChatConnection, thread: Row | undefined, at: string) {
  if (!thread || connection.status !== "online") return;
  if (text(thread.lastReadAt) >= at) return;
  void connection
    .call("thread.markRead", { id: text(thread.id), at }, `read:${text(thread.id)}:${at}`)
    .catch(() => undefined);
}

/** Sends this device's older seen times up once, so moving unread to the thread loses nothing. */
export function useSeenMigration(connection: ChatConnection, seen: Record<string, string>) {
  const done = useRef(false);
  const threads = connection.snapshot.entities.thread;
  useEffect(() => {
    if (done.current || connection.status !== "online" || !threads?.length) return;
    done.current = true;
    for (const thread of threads) {
      const at = seen[text(thread.id)];
      if (at) markRead(connection, thread, at);
    }
  }, [connection, seen, threads]);
}
