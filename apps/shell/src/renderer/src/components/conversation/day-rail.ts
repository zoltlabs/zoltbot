// C20: where each day starts in a chat, for the day rail. Pure, so the boundary
// rules are tested without a renderer.

export interface DayItem {
  id: string;
  /** ISO time the item was created; items without a valid one are skipped. */
  createdAt?: string;
}

export interface DayStart {
  /** Local calendar day, as YYYY-MM-DD. */
  day: string;
  /** The first item of that day; the rail scrolls to it. */
  firstId: string;
  /** The day's midnight in local time. */
  date: Date;
}

/** The rail shows only when a chat covers more than this many calendar days. */
export const RAIL_MIN_SPAN_DAYS = 2;

function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The first item of each local calendar day, oldest first. Items are in chat
 * order; one with an earlier time than the day before it (a clock change, an
 * imported message) still counts toward its own day, which keeps its first item.
 */
export function dayStarts(items: readonly DayItem[]): DayStart[] {
  const seen = new Map<string, DayStart>();
  for (const item of items) {
    if (!item.createdAt) continue;
    const at = new Date(item.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    const day = localDay(at);
    if (seen.has(day)) continue;
    seen.set(day, {
      day,
      firstId: item.id,
      date: new Date(at.getFullYear(), at.getMonth(), at.getDate()),
    });
  }
  return [...seen.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Calendar days from the first day to the last, counting both. */
export function spanDays(days: readonly DayStart[]): number {
  if (days.length === 0) return 0;
  const first = days[0].date;
  const last = days[days.length - 1].date;
  // Round, so a daylight-saving change doesn't cost a day.
  return Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
}

export function showsRail(days: readonly DayStart[]): boolean {
  return spanDays(days) > RAIL_MIN_SPAN_DAYS;
}

/** "Tuesday, November 18", with the year when it isn't this year. */
export function dayLabel(date: Date, now = new Date(), locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

/**
 * The day showing at the top of the view: the last day whose first item starts
 * at or above `top`. `tops` holds each day's first item position, in day order.
 */
export function currentDay(tops: readonly number[], top: number): number {
  let index = 0;
  for (let at = 0; at < tops.length; at++) if (tops[at] <= top) index = at;
  return index;
}
