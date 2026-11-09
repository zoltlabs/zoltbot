import { randomUUID } from "node:crypto";
import { createIdentity, fromB64, type Identity, toB64 } from "@zoltbot/link";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateVault } from "./private-context.js";

/** Only the opaque Keychain reference is stored in SQLite, never the key itself (D124). */
export const identityReferenceKey = "link.identityRef";

/**
 * The Mac's Ed25519 identity for the relay. Created once and kept in the Mac Keychain; the
 * settings row holds the reference so the same identity returns after a restart.
 */
export function macIdentity(options: {
  store: Store;
  vault: PrivateVault | undefined;
  publish(events: DomainEvent[]): void;
}): () => Promise<Identity> {
  let loading: Promise<Identity> | undefined;
  const load = async (): Promise<Identity> => {
    const { vault, store } = options;
    if (!vault) throw new Error("keychain_unavailable");
    const row = store
      .snapshot(["settings"])
      .settings?.find((setting) => setting.key === identityReferenceKey);
    if (typeof row?.value === "string") {
      const stored = await vault.read(row.value);
      const seed =
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? (stored as Record<string, unknown>).seed
          : undefined;
      if ((stored as { version?: unknown }).version !== 1 || typeof seed !== "string")
        throw new Error("mac_identity_invalid");
      return createIdentity(fromB64(seed));
    }
    const identity = createIdentity();
    const { reference } = await vault.put({ version: 1, seed: toB64(identity.secretKey) });
    const commandId = `link-identity:${randomUUID()}`;
    const before = store.lastSeq();
    store.dispatch(commandId, () => ({
      events: [
        {
          eventId: `${commandId}:0`,
          aggregateType: "settings",
          aggregateId: identityReferenceKey,
          type: "settings.created",
          occurredAt: new Date().toISOString(),
          payload: { key: identityReferenceKey, value: reference },
        },
      ],
      result: null,
    }));
    options.publish(store.eventsSince(before));
    return identity;
  };
  return () => {
    loading ??= load().catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
}
