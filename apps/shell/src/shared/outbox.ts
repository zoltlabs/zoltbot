// C12: messages waiting to send while Zoltbot is unreachable, over IPC.

export const OUTBOX_CHANNELS = {
  outboxSendNow: "outbox:send-now",
  outboxDelete: "outbox:delete",
} as const;

export interface OutboxDesktopApi {
  sendNow: (input: { botId: string; messageId: string }) => Promise<void>;
  delete: (input: { botId: string; messageId: string }) => Promise<void>;
}
