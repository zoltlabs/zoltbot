import type { UsageRecord } from "@zoltbot/protocol";

function cacheRatio(input: number | undefined, read: number | undefined) {
  return input !== undefined &&
    read !== undefined &&
    Number.isSafeInteger(input) &&
    Number.isSafeInteger(read) &&
    input > 0 &&
    read >= 0 &&
    read <= input
    ? read / input
    : undefined;
}
function completeSum(
  rows: readonly UsageRecord[],
  field: "inputTokens" | "outputTokens" | "cacheReadTokens",
) {
  return rows.length && rows.every((row) => typeof row[field] === "number")
    ? rows.reduce((sum, row) => sum + (row[field] as number), 0)
    : undefined;
}
export function summarizeUsage(rows: readonly UsageRecord[]) {
  const inputTokens = completeSum(rows, "inputTokens"),
    outputTokens = completeSum(rows, "outputTokens"),
    reads = completeSum(rows, "cacheReadTokens");
  const knownCostUsd = rows.reduce((sum, row) => sum + (row.costKnown ? (row.costUsd ?? 0) : 0), 0);
  const estimatedCostUsd = rows.reduce(
    (sum, row) => sum + (!row.costKnown ? (row.costUsd ?? 0) : 0),
    0,
  );
  const unknownCostRecords = rows.filter(
    (row) => !row.costKnown || row.costUsd === undefined,
  ).length;
  return {
    inputTokens,
    outputTokens,
    injectedTokens: rows.reduce((sum, row) => sum + row.injectedTokens, 0),
    knownCostUsd,
    estimatedCostUsd,
    unknownCostRecords,
    costKnown: unknownCostRecords === 0,
    costUsd: unknownCostRecords === 0 ? knownCostUsd : undefined,
    cacheRatio: cacheRatio(inputTokens, reads),
  };
}
export interface BudgetLimit {
  scopeType: "task" | "project" | "day";
  scopeId: string;
  usd?: number;
  tokens?: number;
}
function reaches(value: number, threshold: number) {
  return (
    value >= threshold || Math.abs(value - threshold) <= Math.max(1, threshold) * Number.EPSILON * 8
  );
}
export function evaluateBudget(records: readonly UsageRecord[], limit: BudgetLimit) {
  if (!["task", "project", "day"].includes(limit.scopeType))
    throw new Error("invalid_budget_scope");
  if (
    (limit.usd === undefined && limit.tokens === undefined) ||
    [limit.usd, limit.tokens].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
    )
  )
    throw new Error("invalid_budget");
  if (limit.tokens !== undefined && !Number.isSafeInteger(limit.tokens))
    throw new Error("invalid_budget");
  if (
    limit.scopeType === "day" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(limit.scopeId) ||
      !Number.isFinite(Date.parse(`${limit.scopeId}T00:00:00Z`)) ||
      new Date(`${limit.scopeId}T00:00:00Z`).toISOString().slice(0, 10) !== limit.scopeId)
  )
    throw new Error("invalid_budget_day");
  const selected = records.filter((row) =>
    limit.scopeType === "task"
      ? row.taskId === limit.scopeId
      : limit.scopeType === "project"
        ? row.projectId === limit.scopeId
        : row.recordedAt.slice(0, 10) === limit.scopeId,
  );
  const summary = summarizeUsage(selected);
  const tokens = selected.reduce(
    (sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
    0,
  );
  const tokensKnown = selected.every(
    (row) => row.inputTokens !== undefined && row.outputTokens !== undefined,
  );
  const amounts = [
    ...(limit.usd !== undefined
      ? [{ used: summary.knownCostUsd, cap: limit.usd, known: summary.costKnown }]
      : []),
    ...(limit.tokens !== undefined
      ? [{ used: tokens, cap: limit.tokens, known: tokensKnown }]
      : []),
  ];
  const status = amounts.some((row) => reaches(row.used, row.cap))
    ? "hard"
    : amounts.some((row) => reaches(row.used, row.cap * 0.8))
      ? "soft"
      : amounts.some((row) => !row.known)
        ? "unknown"
        : "ok";
  return { status, tokens, tokensKnown, ...summary };
}
export interface CacheTurn {
  inputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  toolsHash?: string | undefined;
  instructionsHash?: string | undefined;
  cwd?: string | undefined;
  coldResume?: boolean;
  compacted?: boolean;
}
function ratio(turn: CacheTurn | undefined) {
  return cacheRatio(turn?.inputTokens, turn?.cacheReadTokens);
}
function cause(previous: CacheTurn | undefined, current: CacheTurn) {
  if (current.compacted) return "compaction";
  if (current.coldResume) return "cold_resume";
  if (!previous) return "first_turn";
  for (const [field, label] of [
    ["model", "model_changed"],
    ["toolsHash", "tools_changed"],
    ["instructionsHash", "instructions_changed"],
    ["cwd", "cwd_changed"],
    ["effort", "effort_changed"],
  ] as const)
    if (
      previous[field] !== undefined &&
      current[field] !== undefined &&
      previous[field] !== current[field]
    )
      return label;
  return undefined;
}
export function analyzeCache(turns: readonly CacheTurn[]) {
  const current = turns.at(-1),
    previous = turns.at(-2);
  if (!current) return { ratio: undefined, broke: false, cause: undefined, diagnostic: false };
  const currentRatio = ratio(current),
    previousRatio = ratio(previous);
  const diagnostic =
    turns.length >= 4 &&
    turns.slice(-3).every((turn, index) => {
      const value = ratio(turn);
      return value !== undefined && value < 0.2 && !cause(turns[turns.length - 4 + index], turn);
    });
  return {
    ratio: currentRatio,
    broke:
      previousRatio !== undefined &&
      currentRatio !== undefined &&
      previousRatio >= 0.5 &&
      previousRatio - currentRatio >= 0.3,
    cause: cause(previous, current),
    diagnostic,
  };
}
