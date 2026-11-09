import type { DomainState } from "@zoltbot/core";
export function dispatchControlPending(
  state: DomainState,
  threadId: string,
  sessionId: string,
): boolean {
  return (state.item ?? []).some((row) => {
    if (row.kind !== "note") return false;
    const body = row.body as Record<string, unknown> | undefined;
    if (
      body?.code === "manual_compaction" &&
      body.sessionId === sessionId &&
      ["sending", "acknowledged"].includes(String(body.state))
    )
      return true;
    return (
      row.threadId === threadId &&
      body?.code === "turn_interrupt" &&
      !!state.turn?.some((turn) => turn.id === body.turnId && turn.status === "running")
    );
  });
}
