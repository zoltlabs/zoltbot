// C12: the phone's outbox, kept in the keychain and sent once the link to the Mac is back.
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import type { Client } from "../data/client";
import { createOutbox, type WaitingMessage } from "../data/outbox";
import { useLink } from "./link";

interface OutboxState {
  messages: readonly WaitingMessage[];
}

export const useOutbox = create<OutboxState>(() => ({ messages: [] }));

const sendVia = (client: Client | undefined) => (message: WaitingMessage) =>
  client
    ? client
        .getState()
        .call(
          "turn.send",
          { threadId: message.threadId, input: message.input, mode: "queue" },
          message.id,
        )
    : Promise.reject(new Error("Not connected yet."));

// Readable after first unlock, so messages can send while the phone is locked.
const keychain = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
};

export const outbox = createOutbox({
  storage: keychain,
  send: (message) => sendVia(useLink.getState().client)(message),
  changed: (messages) => useOutbox.setState({ messages: [...messages] }),
});

let started = false;
/** Loads saved messages once, then sends them whenever the link comes online. */
export function startOutbox(): void {
  if (started) return;
  started = true;
  let watching: (() => void) | undefined;
  const watch = (client: Client | undefined) => {
    watching?.();
    watching = client?.subscribe((state, before) => {
      if (state.status === "online" && before.status !== "online") void outbox.flush();
    });
    if (client?.getState().status === "online") void outbox.flush();
  };
  void outbox.load().then(() => {
    watch(useLink.getState().client);
    useLink.subscribe((state, before) => {
      if (state.client !== before.client) watch(state.client);
    });
  });
}
