// V3: vault.providers, vault.providerItems, vault.providerUnlock and vault.providerForget, and
// reading a login from a password manager at fill time. A Bitwarden session key the owner pastes
// is kept in the keychain; provider-sessions.json holds its reference and the program it was
// given for, and the key goes to no other program.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { VAULT_PROVIDERS, type VaultProviderId, type VaultSource } from "@zoltbot/protocol";
import type { PrivateVault } from "../private-context.js";
import { isSecretReference } from "../secrets.js";
import {
  defaultProviderHost,
  type ProviderHost,
  type ProviderLogin,
  type ProviderSession,
  validItem,
  vaultProviders,
} from "./providers.js";

function provider(value: unknown): VaultProviderId {
  if (typeof value === "string" && (VAULT_PROVIDERS as readonly string[]).includes(value))
    return value as VaultProviderId;
  throw new Error("invalid_provider");
}

export function validSource(value: unknown): VaultSource {
  const source = value as Partial<VaultSource> | null;
  if (typeof source?.item !== "string" || !validItem(source.item))
    throw new Error("provider_item_invalid");
  return { provider: provider(source.provider), item: source.item };
}

export function vaultManagers(host: {
  dataDir: string;
  secrets?: PrivateVault;
  providers?: ProviderHost;
  /** Masks a value read from a manager in logs and refuses it in store writes. */
  guard(value: string): void;
}) {
  const file = path.join(host.dataDir, "provider-sessions.json");
  /** Each kept key: its keychain reference and the program it was given for. */
  type Kept = { reference: string; binary: string };
  const kept = (): Partial<Record<VaultProviderId, Kept>> => {
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(raw).filter(([key, value]) => {
          const entry = value as Partial<Kept> | null;
          return (
            (VAULT_PROVIDERS as readonly string[]).includes(key) &&
            typeof entry?.reference === "string" &&
            isSecretReference(entry.reference) &&
            typeof entry.binary === "string"
          );
        }),
      );
    } catch {
      return {};
    }
  };
  const write = (next: Partial<Record<VaultProviderId, Kept>>) => {
    const temporary = `${file}.${randomUUID()}`;
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeSync(handle, JSON.stringify(next));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, file);
  };
  const managers = vaultProviders({
    ...(host.providers ?? defaultProviderHost(host.dataDir)),
    cwd: host.dataDir,
    async session(id): Promise<ProviderSession | undefined> {
      const entry = kept()[id];
      if (!entry || !host.secrets) return undefined;
      const value = await host.secrets.read(entry.reference).catch(() => undefined);
      if (typeof value !== "string") return undefined;
      host.guard(value);
      return { value, binary: entry.binary };
    },
  });
  /** Drops a kept key from the file, then from the keychain. */
  async function forget(id: VaultProviderId) {
    const { [id]: entry, ...rest } = kept();
    if (!entry) return;
    write(rest);
    await host.secrets?.remove?.(entry.reference).catch(() => {});
  }
  // Unlock and forget each read and rewrite the file; one at a time keeps a key from being lost.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  return {
    async read(source: VaultSource): Promise<ProviderLogin> {
      const login = await managers.read(source.provider, source.item);
      host.guard(login.password);
      return login;
    },
    async api(method: string, params: Record<string, unknown>): Promise<unknown> {
      switch (method) {
        case "vault.providers":
          return { providers: await managers.list() };
        case "vault.providerItems":
          return {
            items: await managers.items(
              provider(params.provider),
              typeof params.search === "string" ? params.search : "",
            ),
          };
        case "vault.providerUnlock": {
          const id = provider(params.provider);
          if (id !== "bitwarden") throw new Error("provider_has_no_session");
          if (!host.secrets) throw new Error("vault_unavailable");
          const secrets = host.secrets;
          const session = String(params.session).trim();
          if (!/^[A-Za-z0-9+/=_-]{16,1000}$/.test(session))
            throw new Error("provider_session_invalid");
          host.guard(session);
          return serial(async () => {
            // The key is checked before anything is kept, so a wrong one leaves the old key.
            const checked = await managers.check(id, session);
            if (checked.state.state !== "ready" || !checked.binary)
              throw new Error("provider_session_invalid");
            const { reference } = await secrets.put(session);
            const before = kept()[id];
            write({ ...kept(), [id]: { reference, binary: checked.binary } });
            if (before) await secrets.remove?.(before.reference).catch(() => {});
            return { provider: checked.state };
          });
        }
        case "vault.providerForget": {
          const id = provider(params.provider);
          return serial(async () => {
            await forget(id);
            return { provider: await managers.state(id) };
          });
        }
        default:
          return undefined;
      }
    },
  };
}
