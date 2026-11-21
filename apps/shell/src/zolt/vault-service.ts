// V1: the vault's IPC handlers. The daemon checks and stores; this side only shapes input and
// turns the daemon's error codes into words.
import { randomUUID } from "node:crypto";
import { vaultHost } from "@zoltbot/protocol";
import {
  VAULT_CHANNELS as C,
  type VaultItem,
  type VaultList,
  type VaultProvider,
  type VaultProviderId,
  type VaultProviderItem,
  type VaultSaveInput,
  type VaultSource,
  type VaultUpdateInput,
} from "../shared/vault";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "call" | "rows">;

const MESSAGES: Record<string, string> = {
  invalid_site: "Enter a site, like github.com.",
  invalid_setup_key: "That isn't a setup key.",
  vault_unavailable: "This Mac's keychain isn't available.",
  vault_full: "The vault is full. Remove a login first.",
  vault_entry_not_found: "It was already removed.",
  provider_missing: "That password manager isn't on this Mac.",
  provider_failed: "The password manager didn't answer. Unlock it and try again.",
  provider_session_invalid: "That key didn't unlock Bitwarden.",
  vault_value_in_manager: "Change it in the password manager.",
};

/** The daemon's error code, as words the owner can act on. */
function failure(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : "";
  const code = Object.keys(MESSAGES).find((key) => message.includes(key));
  return new Error(code ? MESSAGES[code] : fallback);
}

export function parseVaultItem(value: unknown): VaultItem | null {
  if (!isObject(value)) return null;
  const { id, kind, label, sites, username, agents, createdAt, lastUsedAt, source } = value;
  if (typeof id !== "string" || (kind !== "login" && kind !== "totp" && kind !== "secret"))
    return null;
  if (typeof label !== "string" || !Array.isArray(sites) || typeof createdAt !== "string")
    return null;
  const agentList =
    agents === "all"
      ? "all"
      : Array.isArray(agents)
        ? agents.filter((item): item is string => typeof item === "string")
        : null;
  if (!agentList) return null;
  return {
    id,
    kind,
    label,
    sites: sites.filter((site): site is string => typeof site === "string"),
    ...(typeof username === "string" && username ? { username } : {}),
    agents: agentList,
    createdAt,
    ...(typeof lastUsedAt === "string" ? { lastUsedAt } : {}),
    ...(parseSource(source) ? { source: parseSource(source) as VaultSource } : {}),
  };
}

const PROVIDERS = new Set<VaultProviderId>(["1password", "bitwarden", "proton"]);

function parseProvider(value: unknown): VaultProviderId {
  if (typeof value === "string" && PROVIDERS.has(value as VaultProviderId))
    return value as VaultProviderId;
  throw new Error("Invalid password manager.");
}

function parseSource(value: unknown): VaultSource | undefined {
  if (!isObject(value) || typeof value.item !== "string") return undefined;
  try {
    return { provider: parseProvider(value.provider), item: value.item };
  } catch {
    return undefined;
  }
}

function parseProviderState(value: unknown): VaultProvider | null {
  if (!isObject(value) || typeof value.name !== "string") return null;
  const states = ["ready", "locked", "signed_out", "missing", "failed"];
  if (typeof value.state !== "string" || !states.includes(value.state)) return null;
  try {
    return {
      id: parseProvider(value.id),
      name: value.name,
      state: value.state as VaultProvider["state"],
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    };
  } catch {
    return null;
  }
}

function parseAgents(value: unknown): "all" | string[] {
  if (value === "all") return "all";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error("Invalid agents.");
}

function parseSave(value: unknown): VaultSaveInput {
  if (!isObject(value)) throw new Error("Invalid login.");
  if (value.kind !== "login" && value.kind !== "totp") throw new Error("Invalid kind.");
  return {
    kind: value.kind,
    site: requireString(value.site, "site"),
    ...(typeof value.username === "string" ? { username: value.username } : {}),
    agents: parseAgents(value.agents),
    ...(parseSource(value.source)
      ? { source: parseSource(value.source) as VaultSource }
      : { value: requireString(value.value, "value") }),
  };
}

function parseUpdate(value: unknown): VaultUpdateInput {
  if (!isObject(value)) throw new Error("Invalid login.");
  return {
    id: requireString(value.id, "id"),
    ...(typeof value.site === "string" ? { site: value.site } : {}),
    ...(typeof value.username === "string" ? { username: value.username } : {}),
    ...(value.agents !== undefined ? { agents: parseAgents(value.agents) } : {}),
    ...(typeof value.value === "string" && value.value ? { value: value.value } : {}),
  };
}

const entryOf = (result: unknown) => {
  const item = parseVaultItem(isObject(result) ? result.entry : undefined);
  if (!item) throw new Error("Invalid vault entry.");
  return item;
};

export function vaultHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.vaultList]: async (): Promise<VaultList> => {
      const result = await client.call("vault.list", {});
      if (!isObject(result) || !Array.isArray(result.entries))
        return { items: [], available: false };
      return {
        items: result.entries.map(parseVaultItem).filter((item): item is VaultItem => !!item),
        available: result.available === true,
      };
    },
    [C.vaultSave]: async (input) => {
      const save = parseSave(input);
      try {
        return entryOf(
          await client.call(
            "vault.save",
            {
              kind: save.kind,
              sites: [save.site],
              ...(save.username?.trim() ? { username: save.username.trim() } : {}),
              agents: save.agents,
              ...(save.source ? { source: save.source } : { value: save.value }),
            },
            randomUUID(),
          ),
        );
      } catch (error) {
        throw failure(error, "Couldn't save it. Try again.");
      }
    },
    [C.vaultUpdate]: async (input) => {
      const update = parseUpdate(input);
      try {
        return entryOf(
          await client.call(
            "vault.update",
            {
              id: update.id,
              ...(update.site !== undefined
                ? { sites: [update.site], label: vaultHost(update.site) ?? update.site }
                : {}),
              ...(update.username !== undefined ? { username: update.username } : {}),
              ...(update.agents !== undefined ? { agents: update.agents } : {}),
              ...(update.value ? { value: update.value } : {}),
            },
            randomUUID(),
          ),
        );
      } catch (error) {
        throw failure(error, "Couldn't save it. Try again.");
      }
    },
    [C.vaultRemove]: async (input) => {
      try {
        await client.call(
          "vault.remove",
          { id: requireString(input, "id"), confirmed: true },
          randomUUID(),
        );
      } catch (error) {
        throw failure(error, "Couldn't remove it. Try again.");
      }
    },
    // Agents are what tool calls carry; each is named by the owner's own chat with it.
    [C.vaultAgents]: () => {
      const named = new Map<string, string>();
      for (const thread of client.rows("thread")) {
        const agentId = typeof thread.agentId === "string" ? thread.agentId : "";
        if (!agentId || thread.archived || thread.taskId || thread.fork || named.has(agentId))
          continue;
        named.set(
          agentId,
          typeof thread.title === "string" && thread.title ? thread.title : agentId,
        );
      }
      return [...named].map(([id, name]) => ({ id, name }));
    },
    [C.vaultProviders]: async () => {
      const result = await client.call("vault.providers", {});
      return isObject(result) && Array.isArray(result.providers)
        ? result.providers.map(parseProviderState).filter((item) => !!item)
        : [];
    },
    [C.vaultProviderItems]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid request.");
      try {
        const result = await client.call("vault.providerItems", {
          provider: parseProvider(input.provider),
          ...(typeof input.search === "string" && input.search.trim()
            ? { search: input.search.trim().slice(0, 100) }
            : {}),
        });
        if (!isObject(result) || !Array.isArray(result.items)) return [];
        return result.items.flatMap((item): VaultProviderItem[] => {
          if (!isObject(item) || typeof item.id !== "string" || typeof item.title !== "string")
            return [];
          return [
            {
              id: item.id,
              title: item.title,
              ...(typeof item.username === "string" ? { username: item.username } : {}),
              sites: Array.isArray(item.sites)
                ? item.sites.filter((site): site is string => typeof site === "string")
                : [],
            },
          ];
        });
      } catch (error) {
        throw failure(error, "Couldn't read the password manager. Try again.");
      }
    },
    [C.vaultProviderUnlock]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid request.");
      try {
        const result = await client.call(
          "vault.providerUnlock",
          {
            provider: parseProvider(input.provider),
            session: requireString(input.session, "session").trim(),
          },
          randomUUID(),
        );
        const provider = parseProviderState(isObject(result) ? result.provider : undefined);
        if (!provider) throw new Error("Invalid password manager.");
        return provider;
      } catch (error) {
        throw failure(error, "Couldn't unlock it. Try again.");
      }
    },
    [C.vaultSaveSecret]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid secret.");
      const label = requireString(input.label, "label").trim().slice(0, 80);
      const value = requireString(input.value, "value");
      if (!label) throw new Error("Name it first.");
      try {
        const result = await client.call("vault.saveSecret", { label, value }, randomUUID());
        if (!isObject(result) || typeof result.reference !== "string")
          throw new Error("Invalid vault entry.");
        return { reference: result.reference };
      } catch (error) {
        throw failure(error, "Couldn't save it. Try again.");
      }
    },
    [C.vaultProviderForget]: async (input) => {
      try {
        const result = await client.call(
          "vault.providerForget",
          { provider: parseProvider(input) },
          randomUUID(),
        );
        const provider = parseProviderState(isObject(result) ? result.provider : undefined);
        if (!provider) throw new Error("Invalid password manager.");
        return provider;
      } catch (error) {
        throw failure(error, "Couldn't forget the key. Try again.");
      }
    },
    [C.vaultReveal]: async (input) => {
      const result = await client.call("vault.reveal", { id: requireString(input, "id") });
      if (!isObject(result) || typeof result.value !== "string")
        throw new Error("Couldn't show it.");
      return result.value;
    },
  };
}
