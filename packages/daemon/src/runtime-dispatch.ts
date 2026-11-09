import {
  type CommandContext,
  type DomainState,
  type Outcome,
  rejectQueuedInput,
  wakePermissionStamp,
} from "@zoltbot/core";
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

/** Recheck the saved wake boundary after async preflight, immediately before native delivery. */
export function rejectChangedWake(
  state: DomainState,
  candidate: Record<string, unknown>,
  commit: (work: (state: DomainState, context: CommandContext) => Outcome) => unknown,
): boolean {
  const grant = state.wake?.find((w) => w.itemId === candidate.id);
  if (!grant || grant.permissionStamp === wakePermissionStamp(state, String(candidate.threadId)))
    return false;
  commit((snapshot, context) => rejectQueuedInput(snapshot, String(candidate.id), context));
  return true;
}
