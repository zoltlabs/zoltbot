import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DomainState } from "@zoltbot/core";
import {
  type BackupEntry,
  BackupEntrySchema,
  type BackupOrders,
  BackupRoleSchema,
  type DomainEvent,
  parse,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { OwnedRuntime } from "../api-types.js";
import {
  accountKey,
  catalogFreeModels,
  defaultAccountId,
  listAccounts,
  loginKey,
  ordersKey,
  readOrders,
  type StoredAccount,
} from "./records.js";

type Params = Record<string, unknown>;

/** Writes daemon-only settings rows. Settings rows are replaced whole, never deleted. */
export function writeSettings(
  store: Store,
  publish: (events: DomainEvent[]) => void,
  commandId: string,
  build: (state: DomainState) => { key: string; value: unknown }[],
) {
  const before = store.lastSeq();
  const at = new Date().toISOString();
  store.dispatch(commandId, (state) => ({
    events: build(state).map((row, index) => ({
      eventId: `${commandId}:${index}`,
      commandId,
      aggregateType: "settings",
      aggregateId: row.key,
      type: "settings.created",
      occurredAt: at,
      payload: row,
    })),
    result: { ok: true },
  }));
  publish(store.eventsSince(before));
}

/** Accounts, sign-ins and backup orders. Sign-in commands carry folders, never credentials. */
export function backupModelsApi(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  prepareData(value: unknown): Promise<unknown>;
  dataDir: string;
  owned: OwnedRuntime | undefined;
}) {
  const { store } = host;
  const find = (id: string) => {
    const account = listAccounts(store.snapshot(["settings", "agentDefinition"])).find(
      (row) => row.id === id,
    );
    if (!account) throw new Error("model_account_unavailable");
    return account;
  };
  const write = (
    commandId: string | undefined,
    rows: (state: DomainState) => ReturnType<Parameters<typeof writeSettings>[3]>,
  ) => writeSettings(store, host.publish, commandId ?? `backup-models:${randomUUID()}`, rows);
  const login = async (
    call: OwnedRuntime["accountLoginInfo"],
    definitionId: string,
    folder?: string,
  ) => {
    if (!call) throw new Error("provider_login_unavailable");
    const result = await call(definitionId, folder);
    await host.prepareData(result);
    return {
      command: result.command,
      configDirectory: result.configDirectory,
      ...(result.slashCommand ? { slashCommand: result.slashCommand } : {}),
    };
  };
  function entries(value: unknown, state: DomainState): BackupEntry[] {
    if (!Array.isArray(value) || value.length > 8) throw new Error("invalid_backup_order");
    const accounts = listAccounts(state);
    return value.map((raw) => {
      const entry = parse(BackupEntrySchema, raw);
      if (!accounts.some((row) => row.id === entry.accountId))
        throw new Error("model_account_unavailable");
      return entry;
    });
  }
  return async (method: string, params: Params, commandId?: string): Promise<unknown> => {
    switch (method) {
      case "modelAccount.list": {
        const state = store.snapshot(["settings", "agentDefinition", "session"]);
        const items = listAccounts(state);
        const free = catalogFreeModels(state).slice(0, 50);
        return { items, orders: readOrders(state), free };
      }
      case "modelAccount.add": {
        const definitionId = String(params.definitionId);
        const label = String(params.label).trim();
        if (!label) throw new Error("model_account_label_required");
        const tool = find(defaultAccountId(definitionId));
        if (!tool.canAddAccounts) throw new Error("model_account_unsupported");
        const id = randomUUID();
        const folder = path.join(host.dataDir, "accounts", id);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        let signIn: Awaited<ReturnType<typeof login>>;
        try {
          signIn = await login(host.owned?.accountLoginInfo, tool.definitionId, folder);
        } catch (error) {
          rmSync(folder, { recursive: true, force: true });
          throw error;
        }
        const account: StoredAccount = {
          id,
          label,
          definitionId: tool.definitionId,
          configDirectory: folder,
          createdAt: new Date().toISOString(),
        };
        write(commandId, () => [{ key: accountKey(id), value: account }]);
        return { account: find(id), signIn };
      }
      case "modelAccount.signIn": {
        const account = find(String(params.id));
        return login(
          host.owned?.accountLoginInfo,
          account.definitionId,
          account.isDefault ? undefined : account.configDirectory,
        );
      }
      case "modelAccount.check": {
        const account = find(String(params.id));
        if (!host.owned?.accountLogin) throw new Error("provider_login_unavailable");
        const state = await host.owned.accountLogin(
          account.definitionId,
          account.isDefault ? undefined : account.configDirectory,
        );
        write(commandId, () => [
          { key: loginKey(account.id), value: { state, checkedAt: new Date().toISOString() } },
        ]);
        return find(account.id);
      }
      case "modelAccount.remove": {
        if (params.confirmed !== true) throw new Error("confirmation_required");
        const account = find(String(params.id));
        if (account.isDefault) throw new Error("model_account_default");
        write(commandId, (state) => {
          const orders = readOrders(state);
          const keep = (list: BackupEntry[]) => list.filter((e) => e.accountId !== account.id);
          const next: BackupOrders = {
            employee: keep(orders.employee),
            manager: orders.manager && keep(orders.manager),
            ceo: orders.ceo && keep(orders.ceo),
            agents: Object.fromEntries(
              Object.entries(orders.agents).map(([id, list]) => [id, keep(list)]),
            ),
          };
          return [
            { key: accountKey(account.id), value: { removedAt: new Date().toISOString() } },
            { key: ordersKey, value: next },
          ];
        });
        return { ok: true };
      }
      case "backupOrder.set": {
        write(commandId, (state) => {
          const orders = readOrders(state);
          const list = params.entries === null ? null : entries(params.entries, state);
          if (typeof params.threadId === "string") {
            if (!state.thread?.some((row) => row.id === params.threadId))
              throw new Error("thread_unavailable");
            const { [params.threadId]: _old, ...rest } = orders.agents;
            orders.agents = list ? { ...rest, [params.threadId]: list } : rest;
          } else {
            const role = parse(BackupRoleSchema, params.role);
            if (role === "employee") orders.employee = list ?? [];
            else orders[role] = list;
          }
          return [{ key: ordersKey, value: orders }];
        });
        return readOrders(store.snapshot(["settings"]));
      }
      case "provider.loginInfo": {
        if (!host.owned?.loginInfo) throw new Error("provider_login_unavailable");
        const result = await host.owned.loginInfo(String(params.profileId));
        await host.prepareData(result);
        return result;
      }
      default:
        return undefined;
    }
  };
}
