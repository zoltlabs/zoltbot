// A9: a routine's cost per run and its cap, as the routine screen shows them.

/** Caps the phone offers, in dollars per run. */
export const CAP_CHOICES = [1, 5, 20, 50] as const;

export const dollars = (usd: number) => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;

/** "About $0.40 a run", or nothing before the routine has run with recorded spend. */
export function costPerRunText(estimate: number | undefined): string | undefined {
  if (estimate === undefined) return undefined;
  return estimate < 0.01 ? "Under $0.01 a run" : `About ${dollars(estimate)} a run`;
}

/** Reads `limits.get`: the cap and the estimate, when present. */
export function readRoutineCost(value: unknown): { cap?: number; estimate?: number } {
  const row = (value ?? {}) as Record<string, unknown>;
  const number = (key: string) =>
    typeof row[key] === "number" && Number.isFinite(row[key]) ? (row[key] as number) : undefined;
  const cap = number("usdPerRun");
  const estimate = number("estimateUsdPerRun");
  return { ...(cap !== undefined ? { cap } : {}), ...(estimate !== undefined ? { estimate } : {}) };
}

/** A higher cap, or none, lets a run spend more, so the phone asks first (I13). */
export const capWidens = (from: number | undefined, to: number | undefined) =>
  to === undefined ? from !== undefined : from !== undefined && to > from;
