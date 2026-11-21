// C8: emoji reactions on messages, from the owner or the chat's agent. Reactions are Zoltbot's own
// notes about a chat (I2): one settings row per chat, so the phone sees what the Mac sets.

export const MESSAGE_REACTION_EMOJI = [
  "👍",
  "👎",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "🔥",
  "👏",
  "🙏",
  "🤔",
  "👀",
  "✅",
  "🚀",
  "💯",
] as const;
export type MessageReactionEmoji = (typeof MESSAGE_REACTION_EMOJI)[number];
export type ReactionActor = "owner" | "agent";

export interface StoredReaction {
  itemId: string;
  actor: ReactionActor;
  emoji: MessageReactionEmoji;
  at: string;
}

/** Oldest reactions fall off past this many in one chat. */
export const MAX_MESSAGE_REACTIONS = 500;

export const messageReactionsKey = (threadId: string) => `chat.reactions.${threadId}`;

/** The thread a reactions row belongs to, or undefined for any other setting. */
export function messageReactionsThread(key: unknown): string | undefined {
  return typeof key === "string" && key.startsWith("chat.reactions.")
    ? key.slice("chat.reactions.".length) || undefined
    : undefined;
}

export const isReactionEmoji = (value: unknown): value is MessageReactionEmoji =>
  (MESSAGE_REACTION_EMOJI as readonly unknown[]).includes(value);

/** Reads a stored row, dropping anything malformed; one reaction per message and actor. */
export function readMessageReactions(value: unknown): StoredReaction[] {
  if (!Array.isArray(value)) return [];
  const latest = new Map<string, StoredReaction>();
  for (const row of value) {
    const r = row as Partial<StoredReaction> | null;
    if (typeof r?.itemId !== "string" || !r.itemId) continue;
    if ((r.actor !== "owner" && r.actor !== "agent") || !isReactionEmoji(r.emoji)) continue;
    const key = `${r.actor}:${r.itemId}`;
    latest.delete(key);
    latest.set(key, {
      itemId: r.itemId,
      actor: r.actor,
      emoji: r.emoji,
      at: typeof r.at === "string" ? r.at : "",
    });
  }
  return [...latest.values()];
}

/** The list after one actor sets or clears their reaction on one message. */
export function withMessageReaction(
  value: unknown,
  change: { itemId: string; actor: ReactionActor; emoji: MessageReactionEmoji | null; at: string },
): StoredReaction[] {
  const rest = readMessageReactions(value).filter(
    (r) => r.itemId !== change.itemId || r.actor !== change.actor,
  );
  if (!change.emoji) return rest;
  const next = [
    ...rest,
    { itemId: change.itemId, actor: change.actor, emoji: change.emoji, at: change.at },
  ];
  return next.slice(-MAX_MESSAGE_REACTIONS);
}

/** Each message's reactions, by message id. */
export function reactionsByItem(
  value: unknown,
): Map<string, { owner?: MessageReactionEmoji; agent?: MessageReactionEmoji }> {
  const byItem = new Map<string, { owner?: MessageReactionEmoji; agent?: MessageReactionEmoji }>();
  for (const r of readMessageReactions(value))
    byItem.set(r.itemId, { ...byItem.get(r.itemId), [r.actor]: r.emoji });
  return byItem;
}
