// C8: reactions from the owner and the chat's agent, stored by the daemon so the phone sees them.
import { randomUUID } from "node:crypto";
import { messageReactionsKey, reactionsByItem } from "@zoltbot/protocol";
import type { ConversationMessage, MessageReaction } from "../shared/ipc";
import type { DaemonClient, Snapshot } from "./daemon-client";

/** Sets each message's reactions. Reactions saved only on this Mac before C8 still show. */
export function withReactions(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
  local: Readonly<Record<string, MessageReaction>>,
): void {
  const row = (snapshot.entities.settings ?? []).find(
    (setting) => setting.key === messageReactionsKey(threadId),
  );
  const stored = reactionsByItem(row?.value);
  for (const message of messages) {
    const reactions = stored.get(message.id);
    // Always set both: the renderer merges updates, so a missing field would keep its old value.
    message.reaction = reactions?.owner ?? local[`${threadId}:${message.id}`] ?? null;
    message.agentReaction = reactions?.agent ?? null;
  }
}

/** The owner's reaction, saved by the daemon. */
export async function setReaction(
  client: Pick<DaemonClient, "call">,
  input: { botId: string; messageId: string; emoji: MessageReaction | null },
): Promise<void> {
  try {
    await client.call(
      "message.react",
      { threadId: input.botId, itemId: input.messageId, emoji: input.emoji },
      randomUUID(),
    );
  } catch {
    throw new Error("Couldn’t save the reaction. Try again.");
  }
}
