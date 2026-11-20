// C2: Ask aside and Continue in new chat, passed to the daemon.
import { randomUUID } from "node:crypto";
import { ASIDE_CHANNELS as C } from "../shared/aside";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "call">;

function code(error: unknown) {
  return error instanceof Error ? error.message : "";
}

export function asideHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.asideAsk]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid question.");
      const threadId = requireString(input.botId, "botId");
      const text = requireString(input.text, "text").trim();
      try {
        const result = await client.call("turn.aside", { threadId, text }, randomUUID());
        return { threadId: requireString((result as { threadId?: unknown }).threadId, "threadId") };
      } catch (error) {
        throw new Error(
          code(error) === "aside_unavailable"
            ? "This agent can’t take side questions."
            : "Couldn’t ask. Try again.",
        );
      }
    },
    [C.asideContinue]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid aside.");
      try {
        await client.call(
          "thread.continueAside",
          { id: requireString(input.threadId, "threadId") },
          randomUUID(),
        );
      } catch {
        throw new Error("Couldn’t open the aside as a chat. Try again.");
      }
    },
  };
}
