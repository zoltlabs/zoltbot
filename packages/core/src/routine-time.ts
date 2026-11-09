import type { Routine } from "@zoltbot/protocol";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
type Schedule = Routine["schedule"];
function expression(schedule: Schedule) {
  // Constructing the formatter also validates the IANA zone.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
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
/** Strictly after `after`. A folded wall time uses its first instant; a gap rolls forward. */
export function nextRoutineRun(schedule: Schedule, after: string): string {
  const parsed = expression(schedule),
    now = Date.parse(after);
  if (!Number.isFinite(now)) throw new Error("invalid_routine_time");
  if (parsed.interval)
    return new Date((Math.floor(now / parsed.interval) + 1) * parsed.interval).toISOString();
  const today = local(parsed.formatter, now).date;
  for (let offset = 0; offset < 9; offset++) {
    const day = Date.parse(`${today}T00:00:00Z`) + offset * DAY;
    if (parsed.weekdays && !parsed.weekdays.includes(new Date(day).getUTCDay())) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    const wanted = (parsed.hour ?? 0) * 60 + (parsed.minute ?? 0);
    // Search in UTC order, including large UTC offsets and non-hour DST transitions.
    for (let at = day - 15 * 60 * MINUTE; at < day + 39 * 60 * MINUTE; at += MINUTE) {
      const wall = local(parsed.formatter, at);
      if (wall.date === date && wall.minute >= wanted) {
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
