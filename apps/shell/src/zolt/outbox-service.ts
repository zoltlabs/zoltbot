// C12: Send now and Delete on a message waiting to send.
import { type Outbox, unreachable } from "../main/outbox";
import { OUTBOX_CHANNELS as C } from "../shared/outbox";
import { isObject, requireString } from "./parsers";

type Waiting = Pick<Outbox, "sendNow" | "remove">;

export function outboxHandlers(outbox: Waiting): Record<string, (input: unknown) => unknown> {
  const messageId = (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid message.");
    return requireString(input.messageId, "messageId");
  };
  return {
    [C.outboxSendNow]: async (input) => {
      try {
        await outbox.sendNow(messageId(input));
      } catch (error) {
        throw new Error(
          unreachable(error)
            ? "Zoltbot isn’t reachable yet. The message sends when it’s back."
            : "Zoltbot didn’t accept this message. Delete it, or copy it into a new one.",
        );
      }
    },
    [C.outboxDelete]: async (input) => {
      await outbox.remove(messageId(input));
    },
  };
}
