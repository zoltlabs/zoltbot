import { randomUUID } from "node:crypto";
import { STARRED_MODELS_SETTING, TASK_RUNNING_LIMIT_SETTING } from "@zoltbot/protocol";
import type { ConversationMessage } from "../shared/ipc";
import {
  type AddModelAccountInput,
  type BackupEntryView,
  type BackupOrdersView,
  type ModelAccountView,
  type ModelSignIn,
  type ModelSwitchDialog,
  type ModelsDesktopApi,
  RUNNING_LIMIT,
  type SetBackupOrderInput,
} from "../shared/models";
import type { DaemonClient, Row } from "./daemon-client";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A time of day in the Mac's own format, such as "3:40 PM". */
export function timeOfDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function toAccountView(row: Row, definitions: Row[]): ModelAccountView {
  const definition = definitions.find((item) => item.id === row.definitionId);
  const providerName = text(definition?.displayName) || text(row.provider);
  const label = text(row.label);
  const limit = (row.limit ?? null) as { resetsAt?: string } | null;
  const login = text(row.login);
  return {
    id: text(row.id),
    name: row.isDefault === true ? label : `${providerName} · ${label}`,
    label,
    definitionId: text(row.definitionId),
    providerName,
    isDefault: row.isDefault === true,
    canAddAccounts: row.canAddAccounts === true,
    login: login === "signed_in" || login === "signed_out" ? login : "unknown",
    limitResetsAt: limit?.resetsAt ?? null,
    atLimit: limit !== null,
    inUse: typeof row.inUse === "number" ? row.inUse : 0,
  };
}

function entries(value: unknown): BackupEntryView[] {
  return Array.isArray(value)
    ? (value as Row[]).map((entry) => ({
        accountId: text(entry.accountId),
        ...(text(entry.model) ? { model: text(entry.model) } : {}),
      }))
    : [];
}

export function toOrders(value: unknown): BackupOrdersView {
  const row = (value ?? {}) as Row;
  return {
    employee: entries(row.employee),
    manager: row.manager === null || row.manager === undefined ? null : entries(row.manager),
    ceo: row.ceo === null || row.ceo === undefined ? null : entries(row.ceo),
  };
}

/** The running-task limit in a settings row: the stored value when valid, else the default. */
export function runningLimitFrom(settings: Row[]): number {
  const value = settings.find((row) => row.key === TASK_RUNNING_LIMIT_SETTING)?.value;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RUNNING_LIMIT.min &&
    value <= RUNNING_LIMIT.max
    ? value
    : RUNNING_LIMIT.default;
}

/** A8: the starred model ids in a settings row, or none. */
export function starredFrom(settings: Row[]): string[] {
  const value = settings.find((row) => row.key === STARRED_MODELS_SETTING)?.value;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** Accounts, backup orders and the running-task limit, read and changed through the daemon. */
export function modelsService(client: DaemonClient): ModelsDesktopApi {
  const view = (row: unknown) => toAccountView(row as Row, client.rows("agentDefinition"));
  const signIn = (value: unknown): ModelSignIn => {
    const row = (value ?? {}) as Row;
    return {
      command: text(row.command),
      configDirectory: text(row.configDirectory),
      ...(text(row.slashCommand) ? { slashCommand: text(row.slashCommand) } : {}),
    };
  };
  return {
    async read() {
      const result = (await client.call("modelAccount.list", {})) as Row;
      return {
        accounts: (Array.isArray(result.items) ? result.items : []).map(view),
        orders: toOrders(result.orders),
        free: (Array.isArray(result.free) ? (result.free as Row[]) : [])
          .map((row) => ({
            accountId: text(row.accountId),
            model: text(row.model),
            name: text(row.name),
          }))
          .filter((row) => row.accountId && row.model),
      };
    },
    async addAccount(input: AddModelAccountInput) {
      const result = (await client.call(
        "modelAccount.add",
        { definitionId: input.definitionId, label: input.label.trim() },
        randomUUID(),
      )) as Row;
      return { account: view(result.account), signIn: signIn(result.signIn) };
    },
    async signIn(accountId: string) {
      return signIn(await client.call("modelAccount.signIn", { id: accountId }));
    },
    async check(accountId: string) {
      return view(await client.call("modelAccount.check", { id: accountId }, randomUUID()));
    },
    async remove(accountId: string) {
      await client.call("modelAccount.remove", { id: accountId, confirmed: true }, randomUUID());
    },
    async setOrder(input: SetBackupOrderInput) {
      return toOrders(
        await client.call(
          "backupOrder.set",
          { role: input.role, entries: input.entries },
          randomUUID(),
        ),
      );
    },
    async runningLimit() {
      return runningLimitFrom(client.rows("settings"));
    },
    async setRunningLimit(limit: number) {
      await client.call(
        "settings.set",
        { key: TASK_RUNNING_LIMIT_SETTING, value: limit },
        randomUUID(),
      );
      return limit;
    },
    async starred() {
      return starredFrom(client.rows("settings"));
    },
    async setStarred(ids: string[]) {
      await client.call("settings.set", { key: STARRED_MODELS_SETTING, value: ids }, randomUUID());
      return ids;
    },
  };
}

/** The dialog for an interaction that asks before work moves to another provider. */
export function switchDialogFor(interaction: Row): ModelSwitchDialog | undefined {
  const context = (interaction.context ?? {}) as Row;
  const input = ((context.toolInput ?? {}) as Row).backupSwitch as Row | undefined;
  if (!input || !text(input.provider)) return undefined;
  return {
    from: text(input.from),
    to: text(input.to),
    provider: text(input.provider),
    until: text(input.until) ? timeOfDay(text(input.until)) || null : null,
    project: text(input.project) || null,
  };
}

/** The chat line for a backup model note, or undefined for other notes. */
export function modelSwitchMessage(item: Row): ConversationMessage | undefined {
  const note = (item.body ?? {}) as Row;
  if (note.code !== "model_switch") return undefined;
  const until = text(note.until) ? timeOfDay(text(note.until)) : "";
  const sentence = text(note.text);
  return {
    id: text(item.id),
    author: "assistant",
    source: "system",
    text: until ? `${sentence.replace(/\.$/, "")} until ${until}.` : sentence,
    createdAt: text(item.createdAt),
    status: "completed",
    itemType: note.change === "exhausted" ? "modelSwitchExhausted" : "modelSwitch",
  };
}
