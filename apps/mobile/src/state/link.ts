import { linkId } from "@zoltbot/link";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { create, useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type Client, type ClientState, createClient } from "../data/client";
import { FakeTransport } from "../data/fake";
import { deviceIdentity, type SecretStore } from "../data/link-store";
import {
  addMac,
  chooseMac,
  loadMacs,
  macLimit,
  removeMac,
  renameMac,
  type SavedMac,
  type SavedMacs,
  saveMacs,
  seenMac,
} from "../data/macs";
import { type LinkSocket, type PairedMac, RelayTransport, readPairingUrl } from "../data/relay";
import { sampleMacName } from "../data/sample";
import { useDrawer } from "./drawer";
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
const relays = new WeakMap<Client, RelayTransport>();
/** The relay link behind a client, to register push tokens with that Mac's relay. */
export const relayOf = (client: Client | undefined) => (client ? relays.get(client) : undefined);

interface LinkState {
  booted: boolean;
  /** The shown Mac's client. Every screen reads this one. */
  client?: Client;
  /** Set while showing sample data, so Settings can pretend the Mac went offline. */
  fake?: FakeTransport;
  mac?: PairedMac;
  /** What the person calls the shown Mac. */
  macName: string;
  /** This phone's link id, to mark it in the device list. The same for every Mac. */
  deviceId: string;
  /** Every paired Mac, in the order they were paired. */
  macs: SavedMac[];
  activeId?: string;
  /** One client per paired Mac. The others stay connected for their Needs you counts. */
  clients: Record<string, Client>;
  /** A Mac waiting for Allow, and the Mac to go back to if the person cancels. */
  pairing?: { client: Client; back?: string; paused?: SavedMac };
  boot(): Promise<void>;
  showSample(): Promise<void>;
  leaveSample(): void;
  pair(url: string): Promise<void>;
  cancelPairing(): void;
  switchTo(macId: string): void;
  rename(macId: string, label: string): Promise<void>;
  forget(macId: string): Promise<void>;
}

const sampleMacs = [
  { macId: "sample-studio", name: sampleMacName },
  { macId: "sample-mini", name: "Example Mac mini" },
];

export const useLink = create<LinkState>((set, get) => {
  let saved: SavedMacs = { macs: [] };
  let sample = false;
  let fakes: Record<string, FakeTransport> = {};
  const watchers = new Map<string, () => void>();
  let pairingRun = 0;
  /** The Mac being paired, set before the first await so a restart can't race it. */
  let pairingMacId: string | undefined;

  const persist = async (next: SavedMacs) => {
    saved = next;
    set({ macs: next.macs });
    if (!sample) await saveMacs(keychain, next);
  };
  /** Notes when a Mac was last reachable, at most once an hour. */
  const watch = (macId: string, client: Client) => {
    watchers.get(macId)?.();
    watchers.set(
      macId,
      client.subscribe((state, before) => {
        if (state.status !== "online" || before.status === "online") return;
        const next = seenMac(saved, macId);
        if (next) void persist(next).catch(() => undefined);
      }),
    );
  };
  const show = (macId: string | undefined) => {
    const row = saved.macs.find((mac) => mac.macId === macId);
    const client = macId ? get().clients[macId] : undefined;
    if (!row || !client || !macId) {
      set({ client: undefined, fake: undefined, mac: undefined, macName: "", activeId: undefined });
      return;
    }
    const { relay, macKey, name } = row;
    set({
      client,
      fake: fakes[macId],
      mac: sample ? undefined : { relay, macId, macKey, name },
      macName: row.label,
      activeId: macId,
    });
  };
  const connect = async (
    mac: PairedMac,
    pairing?: ReturnType<typeof readPairingUrl>["pairing"],
  ) => {
    const identity = await deviceIdentity(keychain);
    const transport = new RelayTransport({
      identity,
      mac,
      socket,
      ...(pairing
        ? {
            pairing: { ...pairing, deviceName: Constants.deviceName ?? "iPhone" },
            paired: () => void paired(mac, client),
          }
        : {}),
    });
    const client = createClient(transport);
    relays.set(client, transport);
    return client;
  };
  /** The Mac allowed this phone: keep it, and show it unless the person moved on. */
  const paired = async (mac: PairedMac, client: Client) => {
    if (get().pairing?.client !== client) return;
    pairingMacId = undefined;
    const prior = get().clients[mac.macId];
    if (prior && prior !== client) prior.stop();
    set({ clients: { ...get().clients, [mac.macId]: client }, pairing: undefined });
    watch(mac.macId, client);
    try {
      await persist(addMac(saved, mac));
    } catch {
      /* Kept for this run; pairing again saves it. */
      if (!saved.macs.some((row) => row.macId === mac.macId))
        saved = { ...saved, macs: [...saved.macs, { ...mac, label: mac.name, pairedAt: "" }] };
    }
    // Still on the pairing view: show the new Mac.
    if (get().activeId === undefined) show(mac.macId);
    void usePush
      .getState()
      .refresh(true)
      .catch(() => undefined);
  };
  const stopAll = () => {
    for (const stop of watchers.values()) stop();
    watchers.clear();
    for (const client of Object.values(get().clients)) client.stop();
    get().pairing?.client.stop();
    fakes = {};
    saved = { macs: [] };
    set({
      client: undefined,
      fake: undefined,
      mac: undefined,
      macName: "",
      macs: [],
      activeId: undefined,
      clients: {},
      pairing: undefined,
    });
  };

  return {
    booted: false,
    macName: "",
    deviceId: "",
    macs: [],
    clients: {},
    async boot() {
      try {
        const identity = await deviceIdentity(keychain);
        saved = await loadMacs(keychain);
        const clients: Record<string, Client> = {};
        try {
          for (const mac of saved.macs) clients[mac.macId] = await connect(mac);
        } catch (error) {
          for (const client of Object.values(clients)) client.stop();
          throw error;
        }
        set({ clients, macs: saved.macs, deviceId: linkId(identity.publicKey) });
        for (const [macId, client] of Object.entries(clients)) watch(macId, client);
        show(saved.active);
      } catch {
        /* Start unpaired. */
      }
      set({ booted: true });
    },
    async showSample() {
      stopAll();
      sample = true;
      const stored = await keychain.get("mobile-sample-settings").catch(() => undefined);
      let settings: import("../data/transport").Row[] | undefined;
      try {
        const value = stored ? JSON.parse(stored) : undefined;
        if (Array.isArray(value)) settings = value;
      } catch {
        /* Use the sample defaults. */
      }
      fakes = {
        "sample-studio": new FakeTransport({
          ...(settings ? { settings } : {}),
          onSettings: (rows) => keychain.set("mobile-sample-settings", JSON.stringify(rows)),
        }),
        "sample-mini": new FakeTransport({ quiet: true }),
      };
      const pairedAt = new Date().toISOString();
      saved = {
        active: "sample-studio",
        macs: sampleMacs.map(({ macId, name }) => ({
          relay: "sample",
          macId,
          macKey: "sample",
          name,
          label: name,
          pairedAt,
        })),
      };
      const clients = Object.fromEntries(
        Object.entries(fakes).map(([macId, fake]) => [macId, createClient(fake)]),
      );
      set({ clients, macs: saved.macs, deviceId: "this-iphone" });
      show(saved.active);
    },
    leaveSample() {
      if (!sample) return;
      stopAll();
      sample = false;
    },
    async pair(url) {
      const { mac, pairing } = readPairingUrl(url);
      get().leaveSample();
      if (!get().clients[mac.macId] && saved.macs.length >= macLimit)
        throw new Error(`You can pair up to ${macLimit} Macs. Forget one first.`);
      const run = ++pairingRun;
      const before = get().pairing;
      const back = before ? before.back : get().activeId;
      get().cancelPairing();
      pairingMacId = mac.macId;
      // The relay keeps one connection per phone and Mac, so pairing a listed Mac again pauses it.
      const paused = saved.macs.find((row) => row.macId === mac.macId);
      if (paused) {
        watchers.get(mac.macId)?.();
        watchers.delete(mac.macId);
        get().clients[mac.macId]?.stop();
        const { [mac.macId]: _paused, ...clients } = get().clients;
        set({ clients });
      }
      let client: Client;
      try {
        client = await connect(mac, pairing);
      } catch (error) {
        if (pairingMacId === mac.macId) pairingMacId = undefined;
        if (paused)
          void connect(paused).then((again) => {
            set({ clients: { ...get().clients, [paused.macId]: again } });
            watch(paused.macId, again);
            if (get().activeId === undefined && !get().pairing) show(paused.macId);
          });
        throw error;
      }
      if (run !== pairingRun || pairingMacId !== mac.macId) {
        client.stop();
        return;
      }
      set({
        client,
        fake: undefined,
        mac,
        macName: mac.name,
        activeId: undefined,
        pairing: {
          client,
          ...(back && back !== mac.macId ? { back } : {}),
          ...(paused ? { paused } : {}),
        },
      });
    },
    cancelPairing() {
      const pending = get().pairing;
      if (!pending) return;
      pending.client.stop();
      pairingMacId = undefined;
      set({ pairing: undefined });
      const { paused } = pending;
      if (paused && saved.macs.some((row) => row.macId === paused.macId))
        void connect(paused).then((client) => {
          if (pairingMacId === paused.macId || get().clients[paused.macId]) return client.stop();
          set({ clients: { ...get().clients, [paused.macId]: client } });
          watch(paused.macId, client);
          if (get().activeId === undefined && !get().pairing) show(paused.macId);
        });
      show(
        saved.macs.some((row) => row.macId === pending.back)
          ? pending.back
          : (saved.active ?? saved.macs.find((row) => row.macId !== paused?.macId)?.macId),
      );
    },
    switchTo(macId) {
      get().cancelPairing();
      if (macId === get().activeId || !get().clients[macId]) return;
      void persist(chooseMac(saved, macId)).catch(() => undefined);
      // Projects belong to a Mac, so the drawer starts over on the next one.
      useDrawer.getState().set({ projectId: null });
      show(macId);
    },
    async rename(macId, label) {
      await persist(renameMac(saved, macId, label));
      if (macId === get().activeId) show(macId);
    },
    async forget(macId) {
      watchers.get(macId)?.();
      watchers.delete(macId);
      get().clients[macId]?.stop();
      const { [macId]: _gone, ...clients } = get().clients;
      delete fakes[macId];
      const wasActive = macId === get().activeId;
      set({ clients });
      const next = removeMac(saved, macId);
      await persist(next);
      if (wasActive) {
        useDrawer.getState().set({ projectId: null });
        show(next.active);
      }
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
