import { type Row, text } from "../chat/types.js";

// The main agent. These read the same settings the daemon's chief/identity.ts
// does; the name people see is a setting, so nothing here hard-codes it except the default.

export const chiefKeys = { name: "chief.name", thread: "chief.thread", notes: "chief.notes" };
export const defaultChiefName = "Zolt";

type Entities = Record<string, Row[] | undefined>;
const setting = (entities: Entities, key: string) =>
  entities.settings?.find((row) => row.key === key)?.value;

export function chiefName(entities: Entities): string {
  const value = setting(entities, chiefKeys.name);
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : defaultChiefName;
}
/** The chief's thread while it is live, as the daemon decides it. */
export function chiefThreadId(entities: Entities): string | undefined {
  const id = setting(entities, chiefKeys.thread);
  if (typeof id !== "string") return undefined;
  const thread = entities.thread?.find((row) => row.id === id);
  return thread && !thread.archived && !thread.projectId && !thread.fork && !thread.taskId
    ? id
    : undefined;
}
export interface ChiefNote {
  text: string;
  at: string;
}
export function chiefNotes(entities: Entities): {
  summary?: ChiefNote;
  chats: Record<string, ChiefNote>;
} {
  const value = setting(entities, chiefKeys.notes) as
    | { summary?: ChiefNote; chats?: Record<string, ChiefNote> }
    | undefined;
  return {
    ...(value?.summary && text(value.summary.text) ? { summary: value.summary } : {}),
    chats: value?.chats && typeof value.chats === "object" ? value.chats : {},
  };
}
/** A profile to start the chief with: Claude Code first, since it handles long threads well. */
export function chiefDefaultProfile(entities: Entities): string | undefined {
  const profiles = (entities.agent ?? []).filter((row) => !row.archived && !row.hidden);
  const adapter = (row: Row) =>
    text(
      entities.agentDefinition?.find((definition) => definition.id === row.definitionId)?.adapter,
    );
  return text((profiles.find((row) => adapter(row) === "claude") ?? profiles[0])?.id) || undefined;
}

// Zolt's triage of Needs you and its wake-ups. The daemon owns
// these rows (chief/queue.ts, chief/proactive.ts); the UI reads them and only writes the toggle.

export const chiefQueueKeys = {
  queue: "chief.queue",
  wake: "chief.wake",
  proactive: "chief.proactive",
};
export type ChiefRank = "now" | "today" | "later";
export interface ChiefRecommendation {
  decision: "approve" | "decline" | "answer";
  choice?: string;
  text?: string;
}
export interface ChiefTriage {
  rank: ChiefRank;
  why: string;
  recommend?: ChiefRecommendation;
  at: string;
  outcome?: { result: "agreed" | "overruled" | "edited" | "skipped"; at: string };
}

export function chiefTriage(entities: Entities): Record<string, ChiefTriage> {
  const items = (setting(entities, chiefQueueKeys.queue) as { items?: unknown } | undefined)?.items;
  return items && typeof items === "object" ? (items as Record<string, ChiefTriage>) : {};
}
const rankOrder = (rank: ChiefRank | undefined) =>
  rank === "now" ? 0 : rank === "today" ? 1 : rank === undefined ? 2 : 3;
/** The daemon's queue order: now, today, not triaged, later; blocking, then oldest, within each. */
export function compareQueue(
  triage: Record<string, ChiefTriage>,
  a: { id: string; urgency?: string; createdAt: string },
  b: { id: string; urgency?: string; createdAt: string },
): number {
  return (
    rankOrder(triage[a.id]?.rank) - rankOrder(triage[b.id]?.rank) ||
    Number(b.urgency === "blocking") - Number(a.urgency === "blocking") ||
    a.createdAt.localeCompare(b.createdAt)
  );
}
/** How often your call matched Zolt's in the last `days` days. */
export function chiefAgreement(entities: Entities, now: number, days = 7) {
  let agreed = 0,
    total = 0;
  for (const triage of Object.values(chiefTriage(entities))) {
    const outcome = triage.outcome;
    if (
      !outcome ||
      outcome.result === "skipped" ||
      Date.parse(outcome.at) < now - days * 86_400_000
    )
      continue;
    total += 1;
    if (outcome.result === "agreed") agreed += 1;
  }
  return { agreed, total };
}
export interface ChiefBrief {
  enabled: boolean;
  /** Local "HH:MM". */
  time: string;
}
export interface ChiefWakeSummary {
  enabled: boolean;
  brief: ChiefBrief;
  allowance: number;
  used: number;
  useful: number;
}
/** Today's wake-ups, as the daemon counts them. */
export function chiefWakeSummary(entities: Entities, now: number): ChiefWakeSummary {
  const config = (setting(entities, chiefQueueKeys.proactive) ?? {}) as {
    enabled?: unknown;
    maxTurnsPerDay?: unknown;
    brief?: { enabled?: unknown; time?: unknown };
  };
  const time = config.brief?.time;
  const wake = (setting(entities, chiefQueueKeys.wake) ?? {}) as {
    day?: unknown;
    used?: unknown;
    wasted?: unknown;
    results?: { useful?: unknown }[];
  };
  const max =
    typeof config.maxTurnsPerDay === "number" && Number.isFinite(config.maxTurnsPerDay)
      ? Math.min(12, Math.max(0, Math.round(config.maxTurnsPerDay)))
      : 5;
  const today = wake.day === new Date(now).toLocaleDateString("en-CA");
  return {
    enabled: config.enabled !== false,
    brief: {
      enabled: config.brief?.enabled === true,
      time: typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "08:30",
    },
    allowance:
      typeof wake.wasted === "number" && wake.wasted >= 3 ? Math.max(1, Math.floor(max / 2)) : max,
    used: today && typeof wake.used === "number" ? wake.used : 0,
    useful:
      today && Array.isArray(wake.results)
        ? wake.results.filter((result) => result?.useful === true).length
        : 0,
  };
}
/** The user items the daemon queues to wake Zolt: shown as events, never as your words. */
export const chiefWakePrefix = "chief-wake:";
