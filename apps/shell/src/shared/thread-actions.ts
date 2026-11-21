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
] as const;

export type ThreadAction = (typeof THREAD_ACTIONS)[number];

export interface ThreadActionInput {
  botId: string;
  action: ThreadAction;
}
