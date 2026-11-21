// C10: progress notes an agent posts during a long task, shown as small bubbles in its chat.
// They never become provider messages. One settings row per chat holds them, oldest first.
import {
  chatProgressKey,
  cleanProgress,
  type DomainEvent,
  progressWait,
  withProgressNote,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateInputGuard } from "./private-input.js";

interface Host {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
}

/** Appends a note for a running turn, at most one every 30 seconds per turn. */
export async function writeProgressNote(
  host: Host,
  commandId: string,
  change: { threadId: string; turnId: string; text: string },
) {
  const { store } = host;
  const text = cleanProgress(change.text);
  if (!text) throw new Error("progress_required");
  const key = chatProgressKey(change.threadId);
  const replay = !!store.receipt(commandId);
  // The note is the agent's own free text, shown on the Mac and the phone: no private values.
  if (!replay && (await host.privacy.containsSecret(text))) throw new Error("private_value");
  const check = replay ? undefined : await host.privacy.prepareData(text);
  const before = store.lastSeq();
  store.dispatch(
    commandId,
    (snapshot) => {
      check?.(snapshot);
      const running = snapshot.turn?.some(
        (row) =>
          row.id === change.turnId && row.threadId === change.threadId && row.status === "running",
      );
      if (!running) throw new Error("turn_not_running");
      const raw = snapshot.settings?.find((row) => row.key === key)?.value;
      const now = Date.now();
      const wait = progressWait(raw, change.turnId, now);
      if (wait > 0) throw new Error(`too_soon:${Math.ceil(wait / 1000)}s`);
      const at = new Date(now).toISOString();
      const value = withProgressNote(raw, {
        id: commandId,
        turnId: change.turnId,
        text,
        at,
      });
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
    // Only turn and settings rows are read; skip loading the chat's items.
    { items: { ids: [] } },
  );
  host.publish(store.eventsSince(before));
}
