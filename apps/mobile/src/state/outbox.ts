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

const clientFor = (message: WaitingMessage) => {
  const { clients, client } = useLink.getState();
  return message.macId ? clients[message.macId] : client;
};
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
  send: (message) => sendVia(clientFor(message))(message),
  changed: (messages) => useOutbox.setState({ messages: [...messages] }),
});

let started = false;
/** Loads saved messages once, then sends them whenever the link comes online. */
export function startOutbox(): void {
  if (started) return;
  started = true;
  let watching: (() => void)[] = [];
  // Any Mac coming back sends what waits for it.
  const watch = (clients: Client[]) => {
    for (const stop of watching) stop();
    watching = clients.map((client) =>
      client.subscribe((state, before) => {
        if (state.status === "online" && before.status !== "online") void outbox.flush();
      }),
    );
    if (clients.some((client) => client.getState().status === "online")) void outbox.flush();
  };
  const all = (state: ReturnType<typeof useLink.getState>) => [
    ...new Set([...Object.values(state.clients), ...(state.client ? [state.client] : [])]),
  ];
  let settled = false;
  const settle = (state: ReturnType<typeof useLink.getState>) => {
    const first = state.macs[0]?.macId;
    if (settled || !state.booted || state.fake || !first) return;
    settled = true;
    void outbox.settle(
      first,
      state.macs.map((mac) => mac.macId),
    );
  };
  void outbox.load().then(() => {
    watch(all(useLink.getState()));
    settle(useLink.getState());
    useLink.subscribe((state, before) => {
      settle(state);
      if (state.clients !== before.clients || state.client !== before.client) watch(all(state));
      // A forgotten Mac's messages can never send.
      for (const mac of before.macs)
        if (!state.macs.some((row) => row.macId === mac.macId)) void outbox.dropMac(mac.macId);
    });
  });
}
