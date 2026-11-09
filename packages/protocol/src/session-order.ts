type SessionOrder = { generation?: unknown; startedAt?: unknown; id?: unknown };
export function sessionGeneration(session: SessionOrder): number {
  return typeof session.generation === "number" &&
    Number.isSafeInteger(session.generation) &&
    session.generation > 0
    ? session.generation
    : 0;
}
/** Order one thread's lineage by durable generation, with deterministic legacy fallback. */
export function compareSessions(left: SessionOrder, right: SessionOrder): number {
  return (
    sessionGeneration(right) - sessionGeneration(left) ||
    String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")) ||
    String(right.id ?? "").localeCompare(String(left.id ?? ""))
  );
}
