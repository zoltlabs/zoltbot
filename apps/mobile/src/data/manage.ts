import type { Connection, KnowledgeItem, Routine, Scope } from "@zoltbot/protocol";

// Routines, knowledge, skills and connections as the phone edits them (Release 4).

/** The two schedule shapes zoltd runs: a time on some weekdays, or every N minutes. */
export type Schedule =
  | { kind: "time"; hour: number; minute: number; days: "daily" | "weekdays" | number[] }
  | { kind: "interval"; minutes: number }
  | { kind: "other"; cron: string };

const owner = { kind: "human", id: "local-owner" } as const;
const weekdays = [1, 2, 3, 4, 5];
const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function readSchedule(cron: string): Schedule {
  const interval = /^@every ([1-9]\d{0,5})m$/.exec(cron);
  if (interval) return { kind: "interval", minutes: Number(interval[1]) };
  const time = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(cron);
  if (!time || Number(time[1]) > 59 || Number(time[2]) > 23) return { kind: "other", cron };
  const days = time[3] === "*" ? undefined : [...new Set(time[3]?.split(",").map(Number))].sort();
  return {
    kind: "time",
    minute: Number(time[1]),
    hour: Number(time[2]),
    days: !days ? "daily" : days.join() === weekdays.join() ? "weekdays" : days,
  };
}

export function writeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") return `@every ${schedule.minutes}m`;
  if (schedule.kind === "other") return schedule.cron;
  const days =
    schedule.days === "daily"
      ? "*"
      : (schedule.days === "weekdays" ? weekdays : schedule.days).join(",");
  return `${schedule.minute} ${schedule.hour} * * ${days}`;
}

export const clockText = (hour: number, minute: number) =>
  `${hour}:${String(minute).padStart(2, "0")}`;

/** "9:00 or 21:30" → hour and minute, or undefined when it is not a time. */
export function readClockText(value: string): { hour: number; minute: number } | undefined {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function scheduleLabel(cron: string): string {
  const schedule = readSchedule(cron);
  if (schedule.kind === "other") return cron;
  if (schedule.kind === "interval")
    return schedule.minutes % 60 === 0
      ? `Every ${schedule.minutes === 60 ? "hour" : `${schedule.minutes / 60} hours`}`
      : `Every ${schedule.minutes} min`;
  const at = clockText(schedule.hour, schedule.minute);
  if (schedule.days === "daily") return `Daily at ${at}`;
  if (schedule.days === "weekdays") return `Weekdays at ${at}`;
  return `${schedule.days.map((day) => dayNames[day]).join(", ")} at ${at}`;
}

export const notifyLabel = (notify: Routine["notify"]) =>
  notify === "always" ? "Every result" : "Only when needed";

/** A routine's state in a few words: paused, or when it runs next in its own timezone. */
export function routineStatus(routine: Routine): string {
  if (routine.paused) return "Paused";
  if (routine.event) return "Waiting for events";
  const next = new Date(routine.nextRunAt);
  if (Number.isNaN(next.getTime())) return scheduleLabel(routine.schedule.cron);
  return `Next ${next.toLocaleString(undefined, {
    timeZone: routine.schedule.timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export const runLabel: Record<string, string> = {
  waiting: "Waiting",
  quarantined: "Held",
  queued: "Queued",
  started: "Running",
  skipped: "Skipped",
  missed: "Missed",
  expired: "Expired",
  completed: "Done",
};
export const outcomeLabel: Record<string, string> = {
  nothing: "Nothing to do",
  actionable: "Has results",
  needs_you: "Needs you",
};

/** True when the write lost a race with another device (the Mac's value changed first). */
export function isConflict(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error ?? "");
  return /stale_revision|revision_conflict|setting_conflict|disconnect_changed|_conflict\b/.test(
    code,
  );
}

/** Error text for a failed edit from a management screen. The draft always stays. */
export function writeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? "");
  if (isConflict(error)) return "Changed on your Mac.";
  if (/offline|not connected|did not answer/i.test(code)) return "Not sent. Your Mac is offline.";
  if (code.includes("invalid_routine_schedule"))
    return "Use a time like 9:00 and a valid timezone.";
  if (code.includes("knowledge_duplicate_key")) return "That key is already used here.";
  if (code.includes("skill_name_conflict")) return "Another skill here has the same name.";
  if (code.includes("connection_active_sessions")) return "Running chats use this connection.";
  if (code.includes("connection_health_failed")) return "The service did not answer.";
  if (code.includes("private_value_requires_secure_field"))
    return "That looks like a secret. Add it on your Mac.";
  return "Not saved. Try again.";
}

export const knowledgeKinds = [
  "decision",
  "goal",
  "constraint",
  "requirement",
  "preference",
  "lesson",
  "open_question",
  "glossary",
] as const satisfies readonly KnowledgeItem["kind"][];
export const kindLabel = (kind: string) =>
  kind === "open_question" ? "Open question" : kind.charAt(0).toUpperCase() + kind.slice(1);

export const userScope: Scope = { type: "user", id: "local" };

export function blankKnowledge(id: string, scope: Scope, at: string): KnowledgeItem {
  return {
    id,
    scope,
    kind: "decision",
    title: "",
    body: "",
    tags: [],
    sources: [],
    owner,
    verification: "human",
    writer: owner,
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

export function healthLabel(connection: Connection): {
  label: string;
  tone: "ok" | "danger" | "neutral";
} {
  if (!connection.enabled) return { label: "Off", tone: "neutral" };
  if (connection.credentialStatus === "needs_sign_in")
    return { label: "Sign in on Mac", tone: "danger" };
  if (connection.health === "healthy") return { label: "Healthy", tone: "ok" };
  if (connection.health === "unavailable") return { label: "Unavailable", tone: "danger" };
  return { label: "Not checked", tone: "neutral" };
}
