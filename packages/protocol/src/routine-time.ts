// Routine schedule maths, shared by the daemon, the Mac app and the phone. Pure: Intl only.
import { ROUTINE_NEVER, ROUTINE_ONCE, type Routine } from "./knowledge-workflows.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
type Schedule = Routine["schedule"];
const formatters = new Map<string, Intl.DateTimeFormat>();
/** One formatter per zone; constructing it also validates the IANA zone. */
function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size > 100) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  return formatter;
}
function expression(schedule: Schedule) {
  const formatter = formatterFor(schedule.timezone);
  if (schedule.cron === ROUTINE_ONCE) {
    const at = Date.parse(schedule.at ?? "");
    if (!Number.isFinite(at))
      throw new Error("invalid_routine_schedule: A one-time run needs a time");
    return { formatter, at };
  }
  if (schedule.at !== undefined)
    throw new Error("invalid_routine_schedule: Only @once takes a time");
  const interval = /^@every ([1-9]\d{0,5})m$/.exec(schedule.cron);
  if (interval) return { formatter, interval: Number(interval[1]) * MINUTE };
  const cron = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(schedule.cron);
  if (!cron || Number(cron[1]) > 59 || Number(cron[2]) > 23)
    throw new Error("invalid_routine_schedule: Use minute hour * * weekday, or @every Nm");
  return {
    formatter,
    minute: Number(cron[1]),
    hour: Number(cron[2]),
    weekdays: cron[3] === "*" ? undefined : cron[3]?.split(",").map(Number),
  };
}
function local(formatter: Intl.DateTimeFormat, at: number) {
  const p = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
/** Minutes since 1970 on the wall clock, for spotting a clock change between two instants. */
function wallMinutes(formatter: Intl.DateTimeFormat, at: number) {
  const wall = local(formatter, at);
  return Date.parse(`${wall.date}T00:00:00Z`) / MINUTE + wall.minute;
}
/** Strictly after `after`. A folded wall time uses its first instant; a gap rolls forward. */
export function nextRoutineRun(schedule: Schedule, after: string): string {
  const parsed = expression(schedule),
    now = Date.parse(after);
  if (!Number.isFinite(now)) throw new Error("invalid_routine_time");
  // R1: a one-time run, then nothing.
  if (parsed.at !== undefined)
    return parsed.at > now ? new Date(parsed.at).toISOString() : ROUTINE_NEVER;
  if (parsed.interval)
    return new Date((Math.floor(now / parsed.interval) + 1) * parsed.interval).toISOString();
  const today = local(parsed.formatter, now).date;
  for (let offset = 0; offset < 9; offset++) {
    const day = Date.parse(`${today}T00:00:00Z`) + offset * DAY;
    if (parsed.weekdays && !parsed.weekdays.includes(new Date(day).getUTCDay())) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    const wanted = (parsed.hour ?? 0) * 60 + (parsed.minute ?? 0);
    const reached = (at: number) => {
      const wall = local(parsed.formatter, at);
      return wall.date === date && wall.minute >= wanted;
    };
    // Search in UTC order, including large UTC offsets and non-hour DST transitions. Where the
    // wall clock runs straight, halve to the minute. Across a clock change, hour steps find where
    // the wall clock passes the wanted time, then minute steps from two hours back find its first
    // instant (a fold repeats at most an hour, so the first instance can't be skipped).
    const start = day - 15 * 60 * MINUTE,
      end = day + 39 * 60 * MINUTE;
    const passed = (at: number) => {
      const wall = local(parsed.formatter, at);
      return wall.date > date || (wall.date === date && wall.minute >= wanted);
    };
    const straight = (a: number, b: number) =>
      wallMinutes(parsed.formatter, b) - wallMinutes(parsed.formatter, a) === (b - a) / MINUTE;
    let from = start,
      hour = end;
    if (straight(start, end)) {
      if (!passed(end)) continue;
    } else {
      hour = start;
      while (hour < end && !passed(hour)) hour += 60 * MINUTE;
      if (hour >= end) continue;
      from = Math.max(start, hour - 120 * MINUTE);
    }
    if (straight(from, hour)) {
      // No clock change in the window, so the wall clock runs straight: halve to the minute.
      let low = from,
        high = hour;
      while (high - low > MINUTE) {
        const mid = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
        if (passed(mid)) high = mid;
        else low = mid;
      }
      const at = passed(low) ? low : high;
      if (reached(at) && at > now) return new Date(at).toISOString();
      if (reached(at)) continue;
    } else
      for (let at = from; at <= hour; at += MINUTE) {
        if (reached(at)) {
          if (at > now) return new Date(at).toISOString();
          break; // Never pick the second instance of a folded local time.
        }
      }
  }
  throw new Error("invalid_routine_schedule");
}
export function routineGrace(schedule: Schedule, scheduledAt: string): number {
  return Math.min(
    (Date.parse(nextRoutineRun(schedule, scheduledAt)) - Date.parse(scheduledAt)) / 2,
    3 * 60 * MINUTE,
  );
}

/** R3: one upcoming run of a routine. */
export interface UpcomingRun {
  routineId: string;
  at: string;
}

/**
 * R3: the runs of scheduled routines from `from` up to `until`, in time order. Paused, finished
 * and event routines have none; a routine's runs stop at `perRoutine`.
 */
export function upcomingRuns(
  routines: readonly (Pick<Routine, "id" | "paused" | "doneAt" | "nextRunAt" | "schedule"> & {
    event?: unknown;
  })[],
  from: string,
  until: string,
  perRoutine = 200,
): UpcomingRun[] {
  const runs: UpcomingRun[] = [];
  for (const routine of routines) {
    if (routine.event || routine.paused || routine.doneAt) continue;
    try {
      let at =
        routine.nextRunAt > from ? routine.nextRunAt : nextRoutineRun(routine.schedule, from);
      for (let count = 0; at <= until && count < perRoutine; count++) {
        runs.push({ routineId: routine.id, at });
        at = nextRoutineRun(routine.schedule, at);
      }
    } catch {
      // A schedule this version can't read has no runs to show.
    }
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at) || a.routineId.localeCompare(b.routineId));
}
