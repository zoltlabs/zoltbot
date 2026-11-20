// S6: totals for the Usage page's chart and table. Pure, so it's tested without a renderer.
import type { SpendRow } from "../../shared/spend";
import { formatNumber } from "./i18n";

export const SPEND_RANGES = ["today", "7d", "30d"] as const;
export type SpendRange = (typeof SPEND_RANGES)[number];
export type SpendMeasure = "cost" | "tokens";

const DAYS: Record<SpendRange, number> = { today: 1, "7d": 7, "30d": 30 };
/** The chart names this many chats or agents; the rest fold into Other. */
export const CHART_SERIES = 5;
export const OTHER = "other";

/** A local calendar day, YYYY-MM-DD. */
export function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight at the start of the range, and each day in it, oldest first. */
export function rangeDays(range: SpendRange, now: Date): { from: Date; days: string[] } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS[range] - 1));
  const days = Array.from({ length: DAYS[range] }, (_, index) =>
    dayKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + index)),
  );
  return { from, days };
}

export interface BotSpend {
  botId: string;
  botName: string;
  costUsd: number;
  /** False when any of its runs had no reported cost. */
  costKnown: boolean;
  tokens: number;
}

export function spendByBot(rows: readonly SpendRow[]): BotSpend[] {
  const totals = new Map<string, BotSpend>();
  for (const row of rows) {
    const total = totals.get(row.botId) ?? {
      botId: row.botId,
      botName: row.botName,
      costUsd: 0,
      costKnown: true,
      tokens: 0,
    };
    total.costUsd += row.costUsd;
    total.costKnown &&= row.costKnown;
    total.tokens += row.tokens;
    totals.set(row.botId, total);
  }
  return [...totals.values()];
}

export function sortSpend(totals: readonly BotSpend[], by: SpendMeasure): BotSpend[] {
  const value = (total: BotSpend) => (by === "cost" ? total.costUsd : total.tokens);
  return [...totals].sort((a, b) => value(b) - value(a) || a.botName.localeCompare(b.botName));
}

/** Cost when any was reported, otherwise tokens, so the chart is never empty for lack of prices. */
export function chartMeasure(rows: readonly SpendRow[]): SpendMeasure {
  return rows.some((row) => row.costUsd > 0) ? "cost" : "tokens";
}

export interface DaySpend {
  day: string;
  /** Amount per series, keyed by bot id or OTHER. */
  values: Record<string, number>;
  total: number;
}

/**
 * Each day's amount per series. Series are the top CHART_SERIES chats over the whole range, in
 * that order, then Other; a series keeps its place whatever the day.
 */
export function spendByDay(
  rows: readonly SpendRow[],
  days: readonly string[],
  measure: SpendMeasure,
): { series: { id: string; name: string }[]; days: DaySpend[] } {
  const ranked = sortSpend(spendByBot(rows), measure);
  const named = ranked.slice(0, CHART_SERIES);
  const ids = new Set(named.map((total) => total.botId));
  const series = named.map((total) => ({ id: total.botId, name: total.botName }));
  if (ranked.length > CHART_SERIES) series.push({ id: OTHER, name: "" });
  const byDay = new Map(days.map((day) => [day, { day, values: {}, total: 0 } as DaySpend]));
  for (const row of rows) {
    const entry = byDay.get(dayKey(new Date(row.at)));
    if (!entry) continue;
    const id = ids.has(row.botId) ? row.botId : OTHER;
    const amount = measure === "cost" ? row.costUsd : row.tokens;
    entry.values[id] = (entry.values[id] ?? 0) + amount;
    entry.total += amount;
  }
  return { series, days: [...byDay.values()] };
}

/** The chart's colors, in this fixed order. `--chart-other` draws Other. */
export const CHART_COLORS = 5;

/**
 * A color slot per series. Series that also lead the unfiltered view keep that slot, so a
 * filter never repaints an agent; the others take the free slots in order.
 */
export function seriesColors(
  series: readonly { id: string }[],
  overall: readonly { id: string }[],
): Map<string, number> {
  const fixed = new Map(overall.map((entry, index) => [entry.id, index]));
  const slots = new Map<string, number>();
  const used = new Set<number>();
  for (const { id } of series) {
    const slot = fixed.get(id);
    if (id !== OTHER && slot !== undefined && slot < CHART_COLORS) {
      slots.set(id, slot);
      used.add(slot);
    }
  }
  let next = 0;
  for (const { id } of series) {
    if (id === OTHER || slots.has(id)) continue;
    while (used.has(next)) next += 1;
    slots.set(id, next);
    used.add(next);
  }
  return slots;
}

/** A round top for the chart's axis: 1, 2 or 5 times a power of ten, at least `value`. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

export interface SpendTotals {
  costUsd: number;
  costKnown: boolean;
  tokens: number;
}

export function spendTotals(rows: readonly SpendRow[]): SpendTotals {
  const total: SpendTotals = { costUsd: 0, costKnown: true, tokens: 0 };
  for (const row of rows) {
    total.costUsd += row.costUsd;
    total.costKnown &&= row.costKnown;
    total.tokens += row.tokens;
  }
  return total;
}

export function formatUsd(value: number): string {
  return formatNumber(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  });
}

export function formatTokens(value: number): string {
  return formatNumber(value, { notation: value >= 10_000 ? "compact" : "standard" });
}

/** A short amount for the chart's axis: "$0.50", "$12", "$1.2K". */
export function formatUsdShort(value: number): string {
  // Below a cent, cents would read "$0.00" for every tick, so keep two significant digits.
  if (value > 0 && value < 0.01)
    return formatNumber(value, { style: "currency", currency: "USD", maximumSignificantDigits: 2 });
  return formatNumber(value, {
    style: "currency",
    currency: "USD",
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value > 0 && value < 10 ? 2 : 0,
  });
}

/**
 * Whether the chart labels this day: every day for a week, every fifth for a month, counted back
 * from today so today is always labeled.
 */
export function labeledDay(index: number, count: number): boolean {
  return count <= 10 || (count - 1 - index) % 5 === 0;
}

/** Axis ticks as fractions of the top. Token counts are whole, so no half-token tick. */
export function chartTicks(measure: SpendMeasure, top: number): number[] {
  return measure === "tokens" && top < 2 ? [1, 0] : [1, 0.5, 0];
}
