// C5: marks the chat's hidden messages. The message stays in the provider's session (I2, I11);
// only the desktop and phone fold it to one line.
import { messageHiddenKey, readHiddenMessages } from "@zoltbot/protocol";
import type { ConversationMessage } from "../shared/ipc";
import type { Snapshot } from "./daemon-client";

export function hiddenIds(snapshot: Snapshot, threadId: string): Set<string> {
  const row = (snapshot.entities.settings ?? []).find(
    (setting) => setting.key === messageHiddenKey(threadId),
  );
  return new Set(readHiddenMessages(row?.value));
}

export function withHidden(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
): ConversationMessage[] {
  const hidden = hiddenIds(snapshot, threadId);
  if (!hidden.size) return messages;
  return messages.map((message) =>
    hidden.has(message.id) ? { ...message, hidden: true } : message,
  );
}
