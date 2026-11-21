// C9: the agent's own status line for the turn it is running. One settings row per chat holds
// the newest line with its turn id; readers ignore it once that turn is over, so it clears itself.
import { type ChatStatus, chatStatusKey, cleanStatus, type DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateInputGuard } from "./private-input.js";

interface Host {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
}

/** Sets the status line for a running turn. */
export async function writeChatStatus(
  host: Host,
  commandId: string,
  change: { threadId: string; turnId: string; text: string },
) {
  const { store } = host;
  const text = cleanStatus(change.text);
  if (!text) throw new Error("status_required");
  const key = chatStatusKey(change.threadId);
  const replay = !!store.receipt(commandId);
  // The line is the agent's own free text, shown on the Mac and the phone: no private values.
  if (!replay && (await host.privacy.containsSecret(text))) throw new Error("private_value");
  const check = replay ? undefined : await host.privacy.prepareData(text);
  const before = store.lastSeq();
  store.dispatch(
    commandId,
    (snapshot) => {
      check?.(snapshot);
      if (!snapshot.thread?.some((row) => row.id === change.threadId))
        throw new Error("thread_not_found");
      // A late call from a finished turn must not replace the next turn's line.
      const running = snapshot.turn?.some(
        (row) =>
          row.id === change.turnId && row.threadId === change.threadId && row.status === "running",
      );
      if (!running) throw new Error("turn_not_running");
      const current = snapshot.settings?.find((row) => row.key === key)?.value as
        | Partial<ChatStatus>
        | undefined;
      if (current?.turnId === change.turnId && current.text === text)
        return { events: [], result: undefined };
      const at = new Date().toISOString();
      const value: ChatStatus = { turnId: change.turnId, text, at };
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
        result: undefined,
      };
    },
    // Only thread, turn and settings rows are read; skip loading the chat's items.
    { items: { ids: [] } },
  );
  host.publish(store.eventsSince(before));
}
