// C5: Hide and Show a message.
import { randomUUID } from "node:crypto";
import { HIDDEN_CHANNELS as C } from "../shared/hidden";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "call">;

export function hiddenHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.hiddenSet]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid message.");
      const threadId = requireString(input.botId, "botId");
      const itemId = requireString(input.messageId, "messageId");
      const hidden = input.hidden === true;
      try {
        await client.call(
          hidden ? "message.hide" : "message.unhide",
          { threadId, itemId },
          randomUUID(),
        );
      } catch {
        throw new Error(
          hidden
            ? "Couldn’t hide the message. Try again."
            : "Couldn’t show the message. Try again.",
        );
      }
    },
  };
}
