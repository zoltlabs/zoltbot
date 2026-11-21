import { createIdentity, fromB64, type Identity, toB64 } from "@zoltbot/link";

/** The iOS Keychain in the app (expo-secure-store), a Map in tests. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const identityKey = "zoltbot.link.identity.v1";

/** This phone's Ed25519 identity, made once and kept in the Keychain. */
export async function deviceIdentity(store: SecretStore): Promise<Identity> {
  const saved = await store.get(identityKey);
  if (saved) return createIdentity(fromB64(saved));
  const identity = createIdentity();
  await store.set(identityKey, toB64(identity.secretKey));
  return identity;
}

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
