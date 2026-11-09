import { createIdentity, fromB64, type Identity, toB64 } from "@zoltbot/link";
import type { PairedMac } from "./relay.js";

/** The iOS Keychain in the app (expo-secure-store), a Map in tests. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const identityKey = "zoltbot.link.identity.v1";
const macKey = "zoltbot.link.mac.v1";

/** This phone's Ed25519 identity, made once and kept in the Keychain. */
export async function deviceIdentity(store: SecretStore): Promise<Identity> {
  const saved = await store.get(identityKey);
  if (saved) return createIdentity(fromB64(saved));
  const identity = createIdentity();
  await store.set(identityKey, toB64(identity.secretKey));
  return identity;
}

export async function pairedMac(store: SecretStore): Promise<PairedMac | undefined> {
  const saved = await store.get(macKey);
  if (!saved) return undefined;
  try {
    const value = JSON.parse(saved) as PairedMac;
    return value.relay && value.macId && value.macKey ? value : undefined;
  } catch {
    return undefined;
  }
}
export const savePairedMac = (store: SecretStore, mac: PairedMac) =>
  store.set(macKey, JSON.stringify(mac));
/** Forgets the Mac. The identity stays, so pairing again shows the same phone. */
export const forgetMac = (store: SecretStore) => store.remove(macKey);

export function memoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}
