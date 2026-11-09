export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const label = (value: unknown, fallback = "Unknown") =>
  typeof value === "string" && value ? value : fallback;
export function doctorChecks(value: unknown): Record<string, unknown>[] {
  const checks = record(value).checks;
  if (!Array.isArray(checks)) throw new Error("invalid_doctor_report");
  return checks.map(record).filter((row) => typeof row.kind === "string");
}
export function supportLabel(value: unknown): string {
  return (
    (
      {
        tested: "Tested version",
        newer: "Newer than tested",
        older: "Older than tested",
        unsupported: "Unsupported version",
        unknown: "Version support unknown",
      } as Record<string, string>
    )[String(value)] ?? "Version support unknown"
  );
}
export function loginLabel(value: unknown): string {
  return (
    (
      {
        signed_in: "Signed in",
        signed_out: "Sign in required",
        api_key_configured: "API key configured",
        unknown: "Login unknown",
      } as Record<string, string>
    )[String(record(value).state)] ?? "Login unknown"
  );
}
export function capabilityRows(value: unknown): [string, string][] {
  const caps = record(value),
    usage = record(caps.usage);
  const boolean = (value: unknown) => (value === true ? "Yes" : value === false ? "No" : "Unknown");
  return [
    ["Resume", boolean(caps.resume)],
    ["Fork", boolean(caps.fork)],
    [
      "Mid turn input",
      (
        { native: "Native steering", queue_only: "Queued", none: "Unavailable" } as Record<
          string,
          string
        >
      )[String(caps.steer)] ?? "Unknown",
    ],
    ["Concurrent turns", boolean(caps.concurrentTurns)],
    ["Token usage", boolean(usage.tokens)],
    ["Cost reports", boolean(usage.cost)],
    ["Context usage", boolean(usage.context)],
    ["Cache reports", boolean(usage.cache)],
  ];
}

/** "check_required" → "Needs a check": daemon states read as sentences, never raw codes. */
export function stateLabel(value: unknown, fallback = "Not checked yet"): string {
  const raw = typeof value === "string" ? value : "";
  const known: Record<string, string> = {
    unknown: "Not checked yet",
    check_required: "Needs a check",
    available: "Available",
    unavailable: "Unavailable",
    missing: "Missing",
    ok: "OK",
    ready: "Ready",
    none: "None",
    granted: "Allowed",
    denied: "Not allowed",
  };
  if (!raw) return fallback;
  const phrase = known[raw] ?? raw.replaceAll("_", " ");
  return phrase[0]?.toUpperCase() + phrase.slice(1);
}
