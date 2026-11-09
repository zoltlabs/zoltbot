import { type CommandContext, handle, type Outcome } from "./commands.js";
import { applyEvents, type DomainState } from "./projectors.js";

/** Claim one human stop for an explicit running turn before touching the native process. */
export function requestTurnInterrupt(
  state: DomainState,
  threadId: string,
  turnId: string,
  itemId: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_interrupt_required");
  const thread = state.thread?.find((row) => row.id === threadId && !row.archived);
  if (!thread) throw new Error("runtime_thread_unavailable");
  const turn = state.turn?.find(
    (row) => row.id === turnId && row.threadId === threadId && row.status === "running",
  );
  if (!turn) throw new Error("interrupt_turn_changed");
  const session = state.session?.find(
    (row) => row.id === turn.sessionId && row.threadId === threadId && row.state === "running",
  );
  if (!session) throw new Error("runtime_session_unavailable");
  const capability = (session.capabilities as Record<string, unknown> | undefined)?.interrupt;
  if (capability !== "native" && capability !== "kill") throw new Error("unsupported_interrupt");
  if (
    state.item?.some((row) => {
      const body = row.body as Record<string, unknown> | undefined;
      return (
        row.threadId === threadId &&
        row.kind === "note" &&
        body?.code === "turn_interrupt" &&
        body.turnId === turnId
      );
    })
  )
    throw new Error("interrupt_already_requested");
  const requested = handle(
    state,
    {
      type: "create",
      kind: "item",
      value: {
        id: itemId,
        threadId,
        turnId,
        kind: "note",
        seq:
          (state.item ?? []).reduce(
            (n, row) => (row.threadId === threadId ? Math.max(n, Number(row.seq)) : n),
            0,
          ) + 1,
        body: {
          code: "turn_interrupt",
          state: "requested",
          sessionId: session.id,
          turnId,
          text: "You requested that this turn stop.",
        },
        createdAt: context.at,
        updatedAt: context.at,
      },
    },
    context,
  );
  const audit = handle(
    applyEvents(state, requested.events),
    {
      type: "create",
      kind: "audit",
      value: {
        id: `audit:${context.commandId}`,
        actor: context.actor,
        action: "turn.interrupt",
        target: turnId,
        result: "allowed",
        detail: { threadId, sessionId: session.id },
        at: context.at,
      },
    },
    context,
  );
  return {
    events: [...requested.events, ...audit.events].map((event, index) => ({
      ...event,
      eventId: `${context.commandId}:${index}`,
    })),
    result: { kind: "interrupt", id: itemId, threadId, turnId, sessionId: session.id },
  };
}
