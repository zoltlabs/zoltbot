import type { Row } from "./types.js";

export interface OverheadMetrics {
  injectedTokens?: number;
  inputTokens?: number;
  percent?: number;
  cacheRatio?: number;
}
function measured(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sum(rows: readonly Row[], key: string): number | undefined {
  if (!rows.length || !rows.every((row) => measured(row[key]))) return undefined;
  const total = rows.reduce((amount, row) => amount + (row[key] as number), 0);
  return Number.isSafeInteger(total) ? total : undefined;
}
function metrics(rows: readonly Row[]): OverheadMetrics | undefined {
  if (!rows.length) return undefined;
  const injectedTokens = sum(rows, "injectedTokens"),
    inputTokens = sum(rows, "inputTokens"),
    reads = sum(rows, "cacheReadTokens");
  const cacheValid = rows.every(
    (row) =>
      measured(row.inputTokens) &&
      measured(row.cacheReadTokens) &&
      row.cacheReadTokens <= row.inputTokens,
  );
  return {
    ...(injectedTokens !== undefined ? { injectedTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(injectedTokens !== undefined && inputTokens !== undefined && inputTokens > 0
      ? { percent: (injectedTokens / inputTokens) * 100 }
      : {}),
    ...(reads !== undefined && inputTokens !== undefined && inputTokens > 0 && cacheValid
      ? { cacheRatio: reads / inputTokens }
      : {}),
  };
}
/** A resumed thread can contain multiple sessions. Never mix their overhead totals. */
export function overheadData(
  rows: readonly Row[],
  sessionId?: string,
  turnId?: string,
): { turn?: OverheadMetrics; session?: OverheadMetrics } {
  if (!sessionId) return {};
  const selected = rows.filter((row) => row.sessionId === sessionId);
  const session = metrics(selected),
    turn = turnId ? metrics(selected.filter((row) => row.turnId === turnId)) : undefined;
  return { ...(turn ? { turn } : {}), ...(session ? { session } : {}) };
}
