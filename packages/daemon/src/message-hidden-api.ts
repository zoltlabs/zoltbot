// C5: message.hide and message.unhide. Only Zoltbot's display changes; the provider's session keeps
// the message (I2, I11). The row changes inside the store's write, so devices can't overwrite each
// other.
import {
  type DomainEvent,
  messageHiddenKey,
  readHiddenMessages,
  withHiddenMessage,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { Redactor } from "./logging.js";
import type { PrivateInputGuard } from "./private-input.js";

export function messageHiddenApi(host: {
  store: Store;
  privacy: PrivateInputGuard;
  redactor: Pick<Redactor, "text">;
  publish(events: DomainEvent[]): void;
}) {
  const { store } = host;
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (method !== "message.hide" && method !== "message.unhide") return undefined;
    if (!commandId) throw new Error("command_id_required");
    const threadId = String(params.threadId);
    const itemId = String(params.itemId);
    const hidden = method === "message.hide";
    if (host.redactor.text(commandId) !== commandId) throw new Error("invalid_command_id");
    const check = store.receipt(commandId) ? undefined : await host.privacy.prepareData(undefined);
    const before = store.lastSeq();
    const result = store.dispatch(
      commandId,
      (snapshot) => {
        check?.(snapshot);
        if (!snapshot.thread?.some((row) => row.id === threadId))
          throw new Error("thread_not_found");
        if (hidden && !snapshot.item?.some((row) => row.id === itemId && row.threadId === threadId))
          throw new Error("message_not_found");
        const key = messageHiddenKey(threadId);
        const current = snapshot.settings?.find((row) => row.key === key)?.value;
        const value = withHiddenMessage(current, itemId, hidden);
        const out = { hidden: value };
        const same = readHiddenMessages(current);
        if (same.includes(itemId) === hidden && same.length === value.length)
          return { events: [], result: out };
        return {
          events: [
            {
              eventId: `${commandId}:0`,
              aggregateType: "settings",
              aggregateId: key,
              type: "settings.created",
              occurredAt: new Date().toISOString(),
              payload: { key, value },
            },
          ],
          result: out,
        };
      },
      { items: { ids: [itemId] } },
    ).result;
    host.publish(store.eventsSince(before));
    return result;
  };
}
