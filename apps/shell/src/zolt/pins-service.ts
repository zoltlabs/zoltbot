// C4: Pin and Unpin a message.
import { randomUUID } from "node:crypto";
import { PIN_CHANNELS as C } from "../shared/pins";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "call">;

export function pinHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.pinsSet]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid pin.");
      const threadId = requireString(input.botId, "botId");
      const itemId = requireString(input.messageId, "messageId");
      const pinned = input.pinned === true;
      try {
        await client.call(
          pinned ? "message.pin" : "message.unpin",
          { threadId, itemId },
          randomUUID(),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "pin_limit")
          throw new Error("This chat has 50 pins. Unpin one first.");
        throw new Error(
          pinned
            ? "Couldn’t pin the message. Try again."
            : "Couldn’t unpin the message. Try again.",
        );
      }
    },
  };
}
