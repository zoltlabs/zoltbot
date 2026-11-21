// V1: vault.list, vault.save, vault.update, vault.remove and vault.reveal. Values go straight to
// the keychain; only references are kept, and no value is returned except by reveal, which the
// Mac guards with its own Touch ID or password prompt.
import { randomUUID } from "node:crypto";
import {
  type DomainEvent,
  parseTotpSetup,
  type VaultAgents,
  type VaultEntry,
  type VaultKind,
  vaultHost,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { Redactor } from "../logging.js";
import type { PrivateVault } from "../private-context.js";
import type { PrivateInputGuard } from "../private-input.js";
import { writeVaultAudit } from "./audit.js";
import { publicEntry, type VaultRecord, VaultRecords } from "./store.js";

/** What the keychain holds for one entry. */
export type VaultValue =
  | { kind: "login"; password: string }
  | {
      kind: "totp";
      secret: string;
      digits: number;
      period: number;
      algorithm: "SHA1" | "SHA256" | "SHA512";
    };

export interface VaultHost {
  dataDir: string;
  store: Store;
  secrets?: PrivateVault;
  privacy: Pick<PrivateInputGuard, "remember">;
  redactor: Pick<Redactor, "register">;
  publish(events: DomainEvent[]): void;
}

const OWNER = { kind: "human" as const, id: "local-owner" };

function sites(input: readonly string[]): string[] {
  const hosts = input.map((site) => vaultHost(site));
  if (hosts.some((host) => !host)) throw new Error("invalid_site");
  return [...new Set(hosts as string[])];
}

function agents(input: VaultAgents): VaultAgents {
  return input === "all" ? "all" : [...new Set(input)];
}

function valueFor(kind: VaultKind, value: string): VaultValue {
  if (kind === "login") return { kind, password: value };
  const setup = parseTotpSetup(value);
  if (!setup) throw new Error("invalid_setup_key");
  return { kind, ...setup };
}

/** The text the owner sees for a value: the password, or the setup key. */
function shown(value: VaultValue): string {
  return value.kind === "login" ? value.password : value.secret;
}

export function readVaultValue(raw: unknown): VaultValue {
  const value = raw as Partial<VaultValue> | null;
  if (value?.kind === "login" && typeof value.password === "string") return value as VaultValue;
  if (value?.kind === "totp" && typeof value.secret === "string") return value as VaultValue;
  throw new Error("vault_value_invalid");
}

export function vaultApi(host: VaultHost) {
  const records = new VaultRecords(host.dataDir);
  // Vault values sit under their own keychain service, which the plain read can't reach.
  const secrets = host.secrets?.forVault?.() ?? host.secrets;
  const keychain = () => {
    if (!secrets) throw new Error("vault_unavailable");
    return secrets;
  };
  /** Values the daemon handled are masked in every log and refused by every store write. */
  const guard = (value: VaultValue) => {
    // A short value would block every message that happens to contain it.
    for (const text of [shown(value), value.kind === "login" ? "" : value.secret])
      if (text.length >= 8) {
        host.privacy.remember(text);
        host.redactor.register(text);
      }
  };
  let revealing = false;
  const audit = (action: string, entryId: string) =>
    writeVaultAudit(host, { action, entryId, actor: OWNER });

  return {
    records,
    /** What the agents' `vault` tool uses. Values stay in the daemon (V2). */
    runtime: {
      records,
      available: () => !!secrets,
      async read(record: VaultRecord): Promise<VaultValue> {
        const value = readVaultValue(await keychain().read(record.reference));
        guard(value);
        return value;
      },
      markUsed(id: string) {
        return records.change((list) => ({
          records: list.map((record) =>
            record.id === id ? { ...record, lastUsedAt: new Date().toISOString() } : record,
          ),
          result: undefined,
        }));
      },
      audit: (input: Parameters<typeof writeVaultAudit>[1]) => writeVaultAudit(host, input),
    },
    async api(method: string, params: Record<string, unknown>): Promise<unknown> {
      if (!method.startsWith("vault.")) return undefined;
      switch (method) {
        case "vault.list":
          return { entries: records.list().map(publicEntry), available: !!host.secrets };
        case "vault.save": {
          const secrets = keychain();
          const kind = params.kind as VaultKind;
          const hosts = sites(params.sites as string[]);
          const value = valueFor(kind, String(params.value));
          guard(value);
          const { reference } = await secrets.put(value);
          const username = typeof params.username === "string" ? params.username.trim() : "";
          const record: VaultRecord = {
            id: randomUUID(),
            kind,
            label: (
              (typeof params.label === "string" && params.label.trim()) ||
              hosts[0] ||
              ""
            ).slice(0, 200),
            sites: hosts,
            ...(kind === "login" && username ? { username } : {}),
            agents: agents(params.agents as VaultAgents),
            createdAt: new Date().toISOString(),
            reference,
          };
          try {
            await records.change((list) => ({ records: [...list, record], result: undefined }));
          } catch (error) {
            await secrets.remove?.(reference).catch(() => {});
            throw error;
          }
          audit("vault.save", record.id);
          return { entry: publicEntry(record) };
        }
        case "vault.update": {
          const id = String(params.id);
          const current = records.get(id);
          if (!current) throw new Error("vault_entry_not_found");
          let reference = current.reference;
          let replaced: string | undefined;
          if (typeof params.value === "string") {
            const secrets = keychain();
            const value = valueFor(current.kind, params.value);
            guard(value);
            if (secrets.replace) await secrets.replace(reference, value);
            else {
              replaced = reference;
              reference = (await secrets.put(value)).reference;
            }
          }
          const entry = await records.change((list) => {
            const index = list.findIndex((record) => record.id === id);
            const before = list[index];
            if (!before) throw new Error("vault_entry_not_found");
            const username =
              typeof params.username === "string" ? params.username.trim() : before.username;
            const { username: _, ...rest } = before;
            const next: VaultRecord = {
              ...rest,
              ...(typeof params.label === "string" && params.label.trim()
                ? { label: params.label.trim() }
                : {}),
              ...(Array.isArray(params.sites) ? { sites: sites(params.sites as string[]) } : {}),
              ...(before.kind === "login" && username ? { username } : {}),
              ...(params.agents !== undefined
                ? { agents: agents(params.agents as VaultAgents) }
                : {}),
              reference,
            };
            // Agents dropped from the list lose the "Always" they were given.
            const allowed = next.agents;
            if (next.trusted && allowed !== "all")
              next.trusted = next.trusted.filter((agentId) => allowed.includes(agentId));
            return { records: list.with(index, next), result: next };
          });
          if (replaced) await secrets?.remove?.(replaced).catch(() => {});
          audit("vault.update", id);
          return { entry: publicEntry(entry) };
        }
        case "vault.remove": {
          if (params.confirmed !== true) throw new Error("confirmation_required");
          const id = String(params.id);
          const removed = await records.change((list) => {
            const record = list.find((item) => item.id === id);
            if (!record) throw new Error("vault_entry_not_found");
            return { records: list.filter((item) => item.id !== id), result: record };
          });
          await secrets?.remove?.(removed.reference).catch(() => {});
          audit("vault.remove", id);
          return { ok: true };
        }
        case "vault.reveal": {
          const secrets = keychain();
          if (!secrets.reveal) throw new Error("reveal_unavailable");
          if (revealing) throw new Error("reveal_in_progress");
          const record = records.get(String(params.id));
          if (!record) throw new Error("vault_entry_not_found");
          let value: VaultValue;
          revealing = true;
          try {
            // The Mac's prompt names the entry it is for.
            const what = record.kind === "login" ? "password" : "setup key";
            const reason = `show the saved ${what} for ${record.label.slice(0, 80)}`;
            value = readVaultValue(await secrets.reveal(record.reference, reason));
          } catch {
            throw new Error("reveal_cancelled");
          } finally {
            revealing = false;
          }
          guard(value);
          audit("vault.reveal", record.id);
          return { value: shown(value) };
        }
        default:
          return undefined;
      }
    },
  };
}

export type VaultApi = ReturnType<typeof vaultApi>;
export type VaultRuntime = VaultApi["runtime"];
export type { VaultEntry };
