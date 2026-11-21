// A3: a muted agent sends no notifications, sounds or badge count. Its requests still wait in
// Needs you, and an approval still reaches the owner, because only they can act on it.
// One settings row per chat, so the Mac and the phone share it.

export const MUTED_PREFIX = "chat.muted.";
export const mutedKey = (threadId: string) => `${MUTED_PREFIX}${threadId}`;

/** Chats the owner muted, from the settings rows. */
export function mutedThreads(
  settings: readonly { key?: unknown; value?: unknown }[] | undefined,
): Set<string> {
  const muted = new Set<string>();
  for (const row of settings ?? [])
    if (typeof row.key === "string" && row.key.startsWith(MUTED_PREFIX) && row.value === true)
      muted.add(row.key.slice(MUTED_PREFIX.length));
  return muted;
}

/** Whether a request from a muted chat may still notify: only approvals do. */
export function notifiesWhenMuted(request: { type?: unknown }): boolean {
  return request.type === "approval";
}

/** Whether a request may notify, sound or count on the badge, given the muted chats. */
export function requestNotifies(
  request: { type?: unknown; threadId?: unknown },
  muted: ReadonlySet<string>,
): boolean {
  return (
    typeof request.threadId !== "string" ||
    !muted.has(request.threadId) ||
    notifiesWhenMuted(request)
  );
}
