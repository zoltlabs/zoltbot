// C4: message.pin and message.unpin. Pins are Zoltbot's own notes about a chat (I2), kept as one
// settings row per chat and changed inside the store's write, so two devices can't overwrite
// each other's pins.
import {
  type DomainEvent,
  messagePinsKey,
  readMessagePins,
  withMessagePin,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { Redactor } from "./logging.js";
import type { PrivateInputGuard } from "./private-input.js";

type Row = Record<string, unknown>;

/** Only words the owner can see and jump to: their messages and the agent's replies. */
function pinnable(item: Row | undefined, threadId: string): boolean {
  if (item?.threadId !== threadId) return false;
  const body = (item.body ?? {}) as Row;
  if (item.kind === "message") return typeof body.text === "string" && !!body.text.trim();
  if (item.kind !== "user" || !Array.isArray(body.input)) return false;
  return (body.input as Row[]).some(
    (part) => part.type === "text" && typeof part.text === "string" && !!part.text.trim(),
  );
}

export function messagePinsApi(host: {
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
    if (method !== "message.pin" && method !== "message.unpin") return undefined;
    if (!commandId) throw new Error("command_id_required");
    const threadId = String(params.threadId);
    const itemId = String(params.itemId);
    const pinned = method === "message.pin";
    if (host.redactor.text(commandId) !== commandId) throw new Error("invalid_command_id");
    const key = messagePinsKey(threadId);
    // Read only the pinned items and this one, not every item in the store.
    const stored = readMessagePins(
      store.snapshot(["settings"]).settings?.find((row) => row.key === key)?.value,
    ).map((pin) => pin.itemId);
    const ids = [...new Set([itemId, ...stored])].slice(0, 100);
    const check = store.receipt(commandId) ? undefined : await host.privacy.prepareData(undefined);
    const before = store.lastSeq();
    const result = store.dispatch(
      commandId,
      (snapshot) => {
        check?.(snapshot);
        if (!snapshot.thread?.some((row) => row.id === threadId))
          throw new Error("thread_not_found");
        const items = new Map((snapshot.item ?? []).map((row) => [row.id, row as Row]));
        if (pinned && !pinnable(items.get(itemId), threadId)) throw new Error("message_not_found");
        const raw = snapshot.settings?.find((row) => row.key === key)?.value;
        // Pins of messages that are gone don't count toward the limit; drop them.
        const current = readMessagePins(raw).filter((pin) => items.has(pin.itemId));
        const value = withMessagePin(current, itemId, pinned, new Date().toISOString());
        const pins = { pins: value };
        if (JSON.stringify(value) === JSON.stringify(readMessagePins(raw)))
          return { events: [], result: pins };
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
          result: pins,
        };
      },
      { items: { ids } },
    ).result;
    host.publish(store.eventsSince(before));
    return result;
  };
}
