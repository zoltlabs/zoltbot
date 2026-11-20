// C4: the open chat's pins, shared by the strip and the message menu (Pin or Unpin).
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { PinnedMessage } from "../../../../shared/pins";

const [state, setState] = createSignal<{ botId?: string; pins: PinnedMessage[] }>({ pins: [] });

export const currentPins = () => state().pins;
export const isPinned = (botId: string | undefined, messageId: string) =>
  state().botId === botId && state().pins.some((pin) => pin.messageId === messageId);

/** Follows one chat's pins: loads them, then updates from conversation snapshots. */
export function watchPins(botId: Accessor<string | undefined>) {
  function load(id: string) {
    void window.openbot.agent
      .readConversation(id)
      .then((snapshot) => {
        if (botId() === id) setState({ botId: id, pins: snapshot.pins ?? [] });
      })
      .catch(() => undefined);
  }
  createEffect(
    on(botId, (id) => {
      setState({ botId: id, pins: [] });
      if (id) load(id);
    }),
  );
  const stop = window.openbot.agent.onEvent((event) => {
    if (event.type === "conversation" && event.snapshot.botId === botId())
      setState({ botId: botId(), pins: event.snapshot.pins ?? [] });
    // A read made while the agent was offline had no history; read again once it is ready.
    const id = botId();
    if (event.type === "status" && event.status.phase === "ready" && id) load(id);
  });
  onCleanup(stop);
}

export function setPinned(botId: string, messageId: string, pinned: boolean) {
  return window.openbot.pins.set({ botId, messageId, pinned });
}
