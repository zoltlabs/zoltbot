import { parseEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
export function viewOrigin(store: Store, id: string) {
  const value = store.record("settings", `view.origin.${id}`)?.value as
    | { threadId?: string }
    | null
    | undefined;
  return value?.threadId;
}
export function viewOriginEvent(commandId: string, id: string, threadId: string | null) {
  const key = `view.origin.${id}`;
  return parseEvent({
    eventId: `${commandId}:origin:${id}`,
    aggregateType: "settings",
    aggregateId: key,
    type: "settings.updated",
    occurredAt: new Date().toISOString(),
    payload: { key, value: threadId ? { threadId } : {} },
  });
}
