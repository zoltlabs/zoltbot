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

/**
 * What clear returns: Zolt's new chat, or its current chat while Zolt writes a handoff (the new
 * chat follows when the daemon switches chief.thread). Other actions return nothing.
 */
export interface ThreadActionResult {
  threadId?: string;
  handingOff?: boolean;
}

export interface ThreadActionInput {
  botId: string;
  action: ThreadAction;
}
