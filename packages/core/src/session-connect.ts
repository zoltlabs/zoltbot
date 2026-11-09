import { compareSessions, parseEvent } from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

/** Record the human's connection intent before opening a native process. */
export function requestSessionConnect(
  state: DomainState,
  threadId: string,
  previousSessionId: string | undefined,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_connection_required");
  if (!state.thread?.some((row) => row.id === threadId && !row.archived))
    throw new Error("thread_unavailable");
  const previous = state.session
    ?.filter((row) => row.threadId === threadId)
    .sort(compareSessions)[0];
  if (previous?.id !== previousSessionId) throw new Error("session_connection_changed");
  if (previous && !["closed", "failed"].includes(String(previous.state)))
    throw new Error("session_already_connected");
  if (
    state.session?.some(
      (row) => row.threadId === threadId && row.endReason === "runtime_cleanup_required",
    )
  )
    throw new Error("runtime_cleanup_required");
  const result = {
    kind: "session_connect",
    threadId,
    previousSessionId: previousSessionId ?? null,
  };
  return {
    result,
    events: [
      parseEvent({
        eventId: `${context.commandId}:0`,
        commandId: context.commandId,
        aggregateType: "audit",
        aggregateId: `audit:${context.commandId}`,
        type: "audit.created",
        occurredAt: context.at,
        payload: {
          id: `audit:${context.commandId}`,
          actor: context.actor,
          action: "session.connect",
          target: threadId,
          result: "allowed",
          detail: { previousSessionId: previousSessionId ?? null },
          at: context.at,
        },
      }),
    ],
  };
}
