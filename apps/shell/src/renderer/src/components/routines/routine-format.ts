// R3: routines in words, and the schedule editor's two shapes. Pure, so it is tested without a
// renderer.
import type { RoutineItem, RoutineSchedule } from "../../../../shared/routines";
import { locale, type MessageKey, t } from "../../i18n";

const WEEKDAYS = [1, 2, 3, 4, 5];

/** What the schedule editor shows: a one-time run, or a repeating one. */
export type ScheduleDraft =
  | { kind: "once"; date: string; time: string; timezone: string }
  | {
      kind: "repeats";
      every: "day" | "weekday" | "interval";
      time: string;
      minutes: number;
      timezone: string;
    }
  /** A cron this editor can't show; kept as it is. */
  | { kind: "custom"; cron: string; timezone: string };

const pad = (value: number) => String(value).padStart(2, "0");

/** The date and time of `at` on the wall clock of `timezone`, as the inputs want them. */
export function wallClock(at: string, timezone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** The instant a wall-clock date and time in `timezone` names; a skipped time rolls forward. */
export function fromWallClock(date: string, time: string, timezone: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return undefined;
  const wanted = `${date} ${time}`;
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(guess)) return undefined;
  // Offsets run from -12 to +14 hours; take the first instant whose wall clock reaches it.
  for (let at = guess - 14 * 3_600_000; at <= guess + 13 * 3_600_000; at += 60_000) {
    const wall = wallClock(new Date(at).toISOString(), timezone);
    if (`${wall.date} ${wall.time}` >= wanted) return new Date(at).toISOString();
  }
  return undefined;
}

export function draftOf(schedule: RoutineSchedule, now = new Date().toISOString()): ScheduleDraft {
  const { cron, timezone } = schedule;
  if (cron === "@once" && schedule.at)
    return { kind: "once", ...wallClock(schedule.at, timezone), timezone };
  const interval = /^@every ([1-9]\d{0,5})m$/.exec(cron);
  if (interval)
    return {
      kind: "repeats",
      every: "interval",
      time: "09:00",
      minutes: Number(interval[1]),
      timezone,
    };
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1,2,3,4,5)$/.exec(cron);
  if (daily && Number(daily[1]) < 60 && Number(daily[2]) < 24)
    return {
      kind: "repeats",
      every: daily[3] === "*" ? "day" : "weekday",
      time: `${pad(Number(daily[2]))}:${pad(Number(daily[1]))}`,
      minutes: 60,
      timezone,
    };
  if (cron === "@once") return { kind: "once", ...wallClock(now, timezone), timezone };
  return { kind: "custom", cron, timezone };
}

/** The schedule a draft saves, or undefined while it is incomplete. */
export function scheduleOf(draft: ScheduleDraft): RoutineSchedule | undefined {
  if (draft.kind === "custom") return { cron: draft.cron, timezone: draft.timezone };
  if (draft.kind === "once") {
    const at = fromWallClock(draft.date, draft.time, draft.timezone);
    return at ? { cron: "@once", at, timezone: draft.timezone } : undefined;
  }
  if (draft.every === "interval")
    return Number.isInteger(draft.minutes) && draft.minutes >= 1 && draft.minutes <= 999_999
      ? { cron: `@every ${draft.minutes}m`, timezone: draft.timezone }
      : undefined;
  const time = /^(\d{2}):(\d{2})$/.exec(draft.time);
  if (!time) return undefined;
  const days = draft.every === "weekday" ? WEEKDAYS.join(",") : "*";
  return { cron: `${Number(time[2])} ${Number(time[1])} * * ${days}`, timezone: draft.timezone };
}

export function dateTimeText(at: string, timezone: string, language = locale()): string {
  return new Date(at).toLocaleString(language, {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Daily at 9:00", "Weekdays at 9:00", "Every 2 hours", "Once, Fri, Nov 6, 2:00 PM". */
export function scheduleText(schedule: RoutineSchedule, language = locale()): string {
  const draft = draftOf(schedule);
  if (draft.kind === "custom") return draft.cron;
  if (draft.kind === "once")
    return schedule.at
      ? t("routines.when.onceAt", { when: dateTimeText(schedule.at, schedule.timezone, language) })
      : t("routines.when.once");
  if (draft.every === "interval")
    return draft.minutes % 60 === 0
      ? t("routines.when.hours", { count: draft.minutes / 60 })
      : t("routines.when.minutes", { count: draft.minutes });
  const [hour, minute] = draft.time.split(":");
  const time = new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString(language, {
    hour: "numeric",
    minute: "2-digit",
  });
  return t(draft.every === "weekday" ? "routines.when.weekdays" : "routines.when.daily", { time });
}

const TRIGGERS: Record<NonNullable<RoutineItem["trigger"]>["kind"], MessageKey> = {
  "github.ci_failed": "routines.trigger.ciFailed",
  "github.review_requested": "routines.trigger.reviewRequested",
  "sentry.issue_created": "routines.trigger.sentryIssue",
};

export function triggerText(trigger: NonNullable<RoutineItem["trigger"]>): string {
  return t(TRIGGERS[trigger.kind], { resource: trigger.resource });
}

/** Where a routine stands: paused, done, or when it runs next. */
export function statusText(item: RoutineItem, language = locale()): string {
  if (item.paused) return t("routines.status.paused");
  if (item.doneAt) return t("routines.status.done");
  if (item.trigger) return t("routines.status.waiting");
  return t("routines.status.next", {
    when: dateTimeText(item.nextRunAt, item.schedule.timezone, language),
  });
}

const RUN_STATUS: Partial<Record<string, MessageKey>> = {
  waiting: "routines.run.waiting",
  quarantined: "routines.run.held",
  queued: "routines.run.queued",
  started: "routines.run.running",
  skipped: "routines.run.skipped",
  missed: "routines.run.missed",
  expired: "routines.run.stopped",
  completed: "routines.run.done",
};

export function runStatusText(status: string): string {
  const key = RUN_STATUS[status];
  return key ? t(key) : status;
}

/** An error's own message, without Electron's "Error invoking remote method" wrapper. */
export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : "";
}
