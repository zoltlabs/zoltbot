// S6: the phone's Usage screen. Totals `usage.query` records by chat, using the snapshot to name
// each chat. Pure, so it's tested without a phone.
import type { Row } from "./transport";
import { text } from "./view";

export type UsageRange = "today" | "7d" | "30d";
export type UsageSort = "cost" | "tokens";

const DAYS: Record<UsageRange, number> = { today: 1, "7d": 7, "30d": 30 };

/** Local midnight at the start of the range. */
export function usageFrom(range: UsageRange, now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS[range] - 1));
}

export interface ChatUsage {
  threadId: string;
  name: string;
  costUsd: number;
  /** False when any of its runs had no reported price. */
  costKnown: boolean;
  tokens: number;
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function usageByChat(
  records: readonly Row[],
  entities: Readonly<Record<string, readonly Row[] | undefined>>,
  sort: UsageSort,
): ChatUsage[] {
  const sessions = new Map((entities.session ?? []).map((row) => [text(row.id), row]));
  const threads = new Map((entities.thread ?? []).map((row) => [text(row.id), row]));
  const totals = new Map<string, ChatUsage>();
  for (const record of records) {
    const threadId = text(sessions.get(text(record.sessionId))?.threadId);
    const total = totals.get(threadId) ?? {
      threadId,
      name: text(threads.get(threadId)?.title),
      costUsd: 0,
      costKnown: true,
      tokens: 0,
    };
    total.costUsd += count(record.costUsd);
    total.costKnown &&= record.costKnown === true;
    total.tokens += count(record.inputTokens) + count(record.outputTokens);
    totals.set(threadId, total);
  }
  const value = (total: ChatUsage) => (sort === "cost" ? total.costUsd : total.tokens);
  return [...totals.values()].sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name));
}

export function formatCost(usd: number, known: boolean): string {
  const amount = `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
  return known ? amount : `${amount}+`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}K`;
  return tokens.toLocaleString("en-US");
}
