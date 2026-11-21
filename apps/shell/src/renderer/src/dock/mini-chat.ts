import type { ConversationMessage } from "../../../shared/ipc";

/** The newest message worth showing in the mini chat: the latest reply or request, as text. */
export function lastMessage(messages: readonly ConversationMessage[]): ConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.hidden || message.notice || message.card) continue;
    if (message.author === "system" || !message.text.trim()) continue;
    return message;
  }
  return null;
}
