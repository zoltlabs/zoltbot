import { TASK_RUNNING_LIMIT_SETTING } from "@zoltbot/protocol";
import { text } from "@zoltbot/ui/chat/types";
import type { AnswerDraft } from "./interactions.js";
import type { Row, Snapshot } from "./transport.js";

// Backup models on the phone: the switch note in a chat, the question before work moves to
// another provider, the account a chat runs on, and Settings › Models. Adding, signing in and
// removing accounts stays on the Mac.

export const RUNNING_LIMIT = { min: 1, max: 20, default: 2 } as const;

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const setting = (snapshot: Snapshot, key: string) =>
  (snapshot.entities.settings ?? []).find((row) => row.key === key)?.value;

/** "3:00 PM" in the phone's clock. */
export function timeOfDay(iso: string, locale?: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * The centered line for a `model_switch` note: "Switched to Work. Back to Personal at 3:00 PM."
 * Undefined for any other note.
 */
export function switchNoteText(
  value: Row,
  clock: (iso: string) => string = (iso) => timeOfDay(iso),
): string | undefined {
  if (value.code !== "model_switch") return undefined;
  const from = text(value.from);
  const to = text(value.to);
  const until = text(value.until) ? clock(text(value.until)) : "";
  if (value.change === "switched" && to)
    return `Switched to ${to}.${until && from ? ` Back to ${from} at ${until}.` : ""}`;
  if (value.change === "returned" && to) return `Back on ${to}.`;
  if (value.change === "exhausted" && from)
    return `${from} is at its limit and no backup is free.${until ? ` Work resumes at ${until}.` : ""}`;
  return text(value.text) || undefined;
}

/** The question the daemon asks before a chat's work moves to another provider. */
export interface SwitchQuestion {
  from: string;
  to: string;
  provider: string;
  until: string;
  project: string;
}
export function switchQuestion(
  interaction: Row | undefined,
  clock: (iso: string) => string = (iso) => timeOfDay(iso),
): SwitchQuestion | undefined {
  const input = record(record(record(interaction?.context).toolInput).backupSwitch);
  if (!text(input.provider)) return undefined;
  return {
    from: text(input.from),
    to: text(input.to),
    provider: text(input.provider),
    until: text(input.until) ? clock(text(input.until)) : "",
    project: text(input.project),
  };
}
/** "Personal is at its limit. Sam moves back at 3:00 PM." */
export function switchDetail(question: SwitchQuestion, who: string): string {
  return [
    question.from ? `${question.from} is at its limit.` : "",
    question.until ? `${who} moves back at ${question.until}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
/** Continue or Wait, and whether to stop asking for this project. */
export function switchAnswer(go: boolean, remember: boolean): AnswerDraft {
  return {
    action: "accept",
    answers: {
      choice: { options: [go ? "continue" : "wait"] },
      remember: { options: [go && remember ? "remember" : "ask"] },
    },
  };
}

/**
 * The account a chat runs on after a switch, for the composer's model pill. Undefined while it
 * runs on its own account.
 */
export function chatAccount(snapshot: Snapshot, threadId: string): string | undefined {
  const active = record(setting(snapshot, `models.active.${threadId}`));
  const id = text(active.accountId);
  if (!id || active.home === true) return undefined;
  if (id.startsWith("default:")) {
    const definition = (snapshot.entities.agentDefinition ?? []).find(
      (row) => row.id === id.slice("default:".length),
    );
    return text(definition?.displayName) || undefined;
  }
  return text(record(setting(snapshot, `models.account.${id}`)).label) || undefined;
}

export interface AccountView {
  id: string;
  /** "Claude · Work" for an added sign-in, "Claude" for the tool's own. */
  name: string;
  definitionId: string;
  /** "At limit · resets 3:00 PM", "Signed out", or "" when it is ready. */
  status: string;
  state: "ready" | "limit" | "signed_out";
}
export function accountViews(
  items: readonly Row[],
  definitions: readonly Row[],
  clock: (iso: string) => string = (iso) => timeOfDay(iso),
): AccountView[] {
  return items.map((row) => {
    const definition = definitions.find((item) => item.id === row.definitionId);
    const provider = text(definition?.displayName) || text(row.provider);
    const label = text(row.label);
    const limit = row.limit ? record(row.limit) : undefined;
    const resets = limit && text(limit.resetsAt) ? clock(text(limit.resetsAt)) : "";
    const signedOut = row.login === "signed_out";
    return {
      id: text(row.id),
      name: row.isDefault === true || !label ? provider || label : `${provider} · ${label}`,
      definitionId: text(row.definitionId),
      status: limit
        ? `At limit${resets ? ` · resets ${resets}` : ""}`
        : signedOut
          ? "Signed out"
          : "",
      state: limit ? "limit" : signedOut ? "signed_out" : "ready",
    };
  });
}

export type BackupRole = "ceo" | "manager" | "employee";
export interface BackupEntry {
  accountId: string;
  model?: string;
}
export interface BackupOrders {
  employee: BackupEntry[];
  manager: BackupEntry[] | null;
  ceo: BackupEntry[] | null;
}
function entries(value: unknown): BackupEntry[] {
  return Array.isArray(value)
    ? (value as Row[]).map((entry) => ({
        accountId: text(entry.accountId),
        ...(text(entry.model) ? { model: text(entry.model) } : {}),
      }))
    : [];
}
export function toOrders(value: unknown): BackupOrders {
  const row = record(value);
  return {
    employee: entries(row.employee),
    manager: row.manager === null || row.manager === undefined ? null : entries(row.manager),
    ceo: row.ceo === null || row.ceo === undefined ? null : entries(row.ceo),
  };
}
/** A7: a free model the catalog lists, on its tool's own sign-in. */
export interface FreeModel {
  accountId: string;
  model: string;
  name: string;
}
export function toFreeModels(value: unknown): FreeModel[] {
  return (Array.isArray(value) ? (value as Row[]) : [])
    .map((row) => ({
      accountId: text(row.accountId),
      model: text(row.model),
      name: text(row.name),
    }))
    .filter((row) => row.accountId && row.model);
}
/** A7: the free models an order doesn't list yet, as entries that fit in its 8 places. */
export function missingFreeModels(order: BackupEntry[], free: FreeModel[]): BackupEntry[] {
  return free
    .filter((item) => !order.some((e) => e.accountId === item.accountId && e.model === item.model))
    .slice(0, Math.max(0, 8 - order.length))
    .map((item) => ({ accountId: item.accountId, model: item.model }));
}
/** The order a role runs: its own, or the employees' when it has none. */
export const orderFor = (orders: BackupOrders, role: BackupRole) => orders[role] ?? orders.employee;

/** Moves one entry up (-1) or down (1); unchanged at either end. */
export function moveEntry<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [entry] = next.splice(index, 1);
  next.splice(to, 0, entry as T);
  return next;
}

/** The stored running-task limit when valid, else the default. */
export function runningLimit(snapshot: Snapshot): number {
  const value = setting(snapshot, TASK_RUNNING_LIMIT_SETTING);
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RUNNING_LIMIT.min &&
    value <= RUNNING_LIMIT.max
    ? value
    : RUNNING_LIMIT.default;
}
export const clampLimit = (value: number) =>
  Math.min(RUNNING_LIMIT.max, Math.max(RUNNING_LIMIT.min, Math.round(value)));
