// S9: what the sidebar's row menu can do to a chat.
export const THREAD_ACTIONS = [
  "pin",
  "unpin",
  "markUnread",
  "markRead",
  "archive",
  "unarchive",
  "mute",
  "unmute",
  /** Zolt only: archive its chat and start a fresh one. */
  "clear",
] as const;

export type ThreadAction = (typeof THREAD_ACTIONS)[number];

/** What clear returns: Zolt's new chat. Other actions return nothing. */
export interface ThreadActionResult {
  threadId?: string;
}

export interface ThreadActionInput {
  botId: string;
  action: ThreadAction;
}
