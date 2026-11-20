// C5: hidden messages. Hiding is Zoltbot's own display choice (I2, I11): the provider's session
// keeps the message, so the agent still remembers it. One settings row per chat lists them.

/** More than any chat needs; past this the oldest hidden message shows again. */
export const MAX_HIDDEN_MESSAGES = 500;

export const messageHiddenKey = (threadId: string) => `chat.hidden.${threadId}`;

/** The thread a hidden-messages row belongs to, or undefined for any other setting. */
export function messageHiddenThread(key: unknown): string | undefined {
  return typeof key === "string" && key.startsWith("chat.hidden.")
    ? key.slice("chat.hidden.".length) || undefined
    : undefined;
}

/** Reads a stored row, dropping anything malformed. */
export function readHiddenMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && !!id))];
}

/** The list after hiding or showing one message, newest last. */
export function withHiddenMessage(value: unknown, itemId: string, hidden: boolean): string[] {
  const ids = readHiddenMessages(value).filter((id) => id !== itemId);
  if (hidden) ids.push(itemId);
  return ids.slice(-MAX_HIDDEN_MESSAGES);
}
