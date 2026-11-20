// C4: the chat's pinned messages, newest pin first, limited to messages still in the chat.
import { messagePinsKey, readMessagePins } from "@zoltbot/protocol";
import type { ConversationMessage } from "../shared/ipc";
import type { PinnedMessage } from "../shared/pins";
import type { Snapshot } from "./daemon-client";

export function storedPins(snapshot: Snapshot, threadId: string): unknown {
  return (snapshot.entities.settings ?? []).find((row) => row.key === messagePinsKey(threadId))
    ?.value;
}

export function pinnedMessages(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
): PinnedMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return readMessagePins(storedPins(snapshot, threadId)).flatMap((pin) => {
    const message = byId.get(pin.itemId);
    if (!message || message.aside || message.hidden || !message.text.trim()) return [];
    const author =
      message.author === "user" ? "user" : message.author === "agent" ? "agent" : "assistant";
    return [{ messageId: message.id, author, text: message.text }];
  });
}
