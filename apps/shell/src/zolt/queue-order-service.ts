// C1: the queue bar's reorder and Send now, passed to the daemon.
import { randomUUID } from "node:crypto";
import { QUEUE_ORDER_CHANNELS as C } from "../shared/queue-order";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "call">;

async function friendly(fallback: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(code === "queue_changed" ? "The queue changed. Try again." : fallback);
  }
}

export function queueOrderHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.queueReorder]: (input) =>
      friendly("Couldn’t reorder the queue. Try again.", async () => {
        if (!isObject(input) || !Array.isArray(input.order)) throw new Error("Invalid queue.");
        const order = input.order.map((id) => requireString(id, "order"));
        await client.call(
          "turn.reorderQueued",
          { threadId: requireString(input.botId, "botId"), order },
          randomUUID(),
        );
      }),
    [C.queueSendNow]: (input) =>
      friendly("Couldn’t send the message. Try again.", async () => {
        if (!isObject(input)) throw new Error("Invalid message.");
        await client.call(
          "turn.sendQueuedNow",
          {
            threadId: requireString(input.botId, "botId"),
            id: requireString(input.deliveryId, "deliveryId"),
          },
          randomUUID(),
        );
      }),
  };
}
