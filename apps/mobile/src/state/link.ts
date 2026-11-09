import { linkId } from "@zoltbot/link";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { create, useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type Client, type ClientState, createClient } from "../data/client";
import { FakeTransport } from "../data/fake";
import {
  deviceIdentity,
  forgetMac,
  pairedMac,
  type SecretStore,
  savePairedMac,
} from "../data/link-store";
import { type LinkSocket, type PairedMac, RelayTransport, readPairingUrl } from "../data/relay";
import { sampleMacName } from "../data/sample";
import { usePush } from "./push";

/** The iOS Keychain, readable only by this app and only after the phone was first unlocked. */
const keychain: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
const socket = (url: string) => new WebSocket(url) as unknown as LinkSocket;

interface LinkState {
  booted: boolean;
  client?: Client;
  /** Set while showing sample data, so Settings can pretend the Mac went offline. */
  fake?: FakeTransport;
  mac?: PairedMac;
  macName: string;
  /** This phone's link id, to mark it in the device list. */
  deviceId: string;
  boot(): Promise<void>;
  showSample(): Promise<void>;
  pair(url: string): Promise<void>;
  disconnect(): Promise<void>;
}

export const useLink = create<LinkState>((set, get) => {
  const replace = (next: Partial<LinkState>) => {
    get().client?.stop();
    set({ client: undefined, fake: undefined, mac: undefined, ...next });
  };
  const relay = async (mac: PairedMac, pairing?: ReturnType<typeof readPairingUrl>["pairing"]) => {
    const identity = await deviceIdentity(keychain);
    const transport = new RelayTransport({
      identity,
      mac,
      socket,
      ...(pairing
        ? {
            pairing: { ...pairing, deviceName: Constants.deviceName ?? "iPhone" },
            paired: () => {
              void savePairedMac(keychain, mac)
                .then(() => usePush.getState().refresh(true))
                .catch(() => undefined);
            },
          }
        : {}),
    });
    replace({
      client: createClient(transport),
      mac,
      macName: mac.name,
      deviceId: linkId(identity.publicKey),
    });
  };
  return {
    booted: false,
    macName: "",
    deviceId: "",
    async boot() {
      const mac = await pairedMac(keychain).catch(() => undefined);
      if (mac) await relay(mac);
      set({ booted: true });
    },
    async showSample() {
      const saved = await keychain.get("mobile-sample-settings").catch(() => undefined);
      let settings: import("../data/transport").Row[] | undefined;
      try {
        const value = saved ? JSON.parse(saved) : undefined;
        if (Array.isArray(value)) settings = value;
      } catch {
        /* Use the sample defaults. */
      }
      const fake = new FakeTransport({
        ...(settings ? { settings } : {}),
        onSettings: (rows) => keychain.set("mobile-sample-settings", JSON.stringify(rows)),
      });
      replace({
        client: createClient(fake),
        fake,
        macName: sampleMacName,
        deviceId: "this-iphone",
      });
    },
    async pair(url) {
      const { mac, pairing } = readPairingUrl(url);
      await relay(mac, pairing);
    },
    async disconnect() {
      replace({ macName: "" });
      await forgetMac(keychain);
    },
  };
});

const idle = createStore<ClientState>(() => ({
  kind: "fake",
  status: "offline",
  loaded: false,
  snapshot: { seq: 0, entities: {}, counters: {} },
  call: () => Promise.reject(new Error("Not connected to your Mac.")),
}));

/** Reads the current client's state; before pairing it reads an empty, offline one. */
export function useClient<T>(selector: (state: ClientState) => T): T {
  const client = useLink((state) => state.client);
  return useStore(client ?? idle, selector);
}
export const useSnapshot = () => useClient((state) => state.snapshot);
export const useCall = () => useClient((state) => state.call);
