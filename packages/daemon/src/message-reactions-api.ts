// C8: message.react for the owner and the chat_signal tool's react for the agent. Reactions are
// Zoltbot's own notes about a chat (I2): one settings row per chat, changed inside the store's
// write so two devices can't overwrite each other.
import {
  type DomainEvent,
  isReactionEmoji,
  messageReactionsKey,
  type ReactionActor,
  readMessageReactions,
  withMessageReaction,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { Redactor } from "./logging.js";
import type { PrivateInputGuard } from "./private-input.js";

type Row = Record<string, unknown>;

interface Host {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
}

/** Sets or clears one actor's reaction on one message in the thread. */
export async function writeReaction(
  host: Host,
  commandId: string,
  change: { threadId: string; itemId: string; actor: ReactionActor; emoji: unknown },
) {
  const { store } = host;
  const { threadId, itemId, actor } = change;
  const emoji = change.emoji === null ? null : change.emoji;
  if (emoji !== null && !isReactionEmoji(emoji)) throw new Error("invalid_reaction");
  const key = messageReactionsKey(threadId);
  const check = store.receipt(commandId) ? undefined : await host.privacy.prepareData(undefined);
  const before = store.lastSeq();
  const result = store.dispatch(
    commandId,
    (snapshot) => {
      check?.(snapshot);
      if (!snapshot.thread?.some((row) => row.id === threadId)) throw new Error("thread_not_found");
      const item = (snapshot.item ?? []).find((row) => row.id === itemId) as Row | undefined;
      const body = (item?.body ?? {}) as Row;
      // An agent reacts only to the person's own messages that have reached it.
      const delivered =
        body.origin !== "agent" &&
        !["queued", "sending", "uncertain", "failed"].includes(String(body.queueState));
      const reactable =
        item?.threadId === threadId &&
        (actor === "agent"
          ? item.kind === "user" && delivered
          : item.kind === "user" || item.kind === "message");
      if (emoji && !reactable) throw new Error("message_not_found");
      const raw = snapshot.settings?.find((row) => row.key === key)?.value;
      const current = readMessageReactions(raw);
      const same = current.find((r) => r.itemId === itemId && r.actor === actor)?.emoji ?? null;
      if (same === emoji) return { events: [], result: { reactions: current } };
      const at = new Date().toISOString();
      const value = withMessageReaction(raw, { itemId, actor, emoji, at });
      const reactions = { reactions: value };
      return {
        events: [
          {
            eventId: `${commandId}:0`,
            aggregateType: "settings",
            aggregateId: key,
            type: "settings.created",
            occurredAt: at,
            payload: { key, value },
          },
        ],
        result: reactions,
      };
    },
    { items: { ids: [itemId] } },
  ).result;
  host.publish(store.eventsSince(before));
  return result;
}

export function messageReactionsApi(host: Host & { redactor: Pick<Redactor, "text"> }) {
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (method !== "message.react") return undefined;
    if (!commandId) throw new Error("command_id_required");
    if (host.redactor.text(commandId) !== commandId) throw new Error("invalid_command_id");
    return writeReaction(host, commandId, {
      threadId: String(params.threadId),
      itemId: String(params.itemId),
      actor: "owner",
      emoji: params.emoji ?? null,
    });
  };
}
