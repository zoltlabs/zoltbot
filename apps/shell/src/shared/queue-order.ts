// C1: reorder queued messages and send one now, over IPC.

export const QUEUE_ORDER_CHANNELS = {
  queueReorder: "queue:reorder",
  queueSendNow: "queue:send-now",
} as const;

export interface QueueOrderDesktopApi {
  /** `order` lists every queued delivery id; it fails when the queue changed meanwhile. */
  reorder: (input: { botId: string; order: string[] }) => Promise<void>;
  /** Steers the running turn when the agent allows it, else sends the message next. */
  sendNow: (input: { botId: string; deliveryId: string }) => Promise<void>;
}
