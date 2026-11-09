import type { DomainState } from "@zoltbot/core";
import type { ForkProvenance } from "@zoltbot/protocol";
/** A folder shared with a native fork has one dispatcher, including the pre-turn send window. */
export function forkWorkspaceBusy(
  state: DomainState,
  threadId: string,
  sessionId: string,
): boolean {
  const session = state.session?.find((r) => r.id === sessionId);
  if (
    !session?.cwd ||
    !state.thread?.some((r) => (r.fork as ForkProvenance | undefined)?.cwd === session.cwd)
  )
    return false;
  const others = (state.session ?? []).filter(
    (r) =>
      r.threadId !== threadId &&
      r.cwd === session.cwd &&
      ["starting", "ready", "running"].includes(String(r.state)),
  );
  return others.some(
    (s) =>
      state.turn?.some((t) => t.sessionId === s.id && t.status === "running") ||
      state.item?.some(
        (i) =>
          i.threadId === s.threadId &&
          i.kind === "user" &&
          ["sending", "uncertain"].includes(
            String((i.body as Record<string, unknown>)?.queueState),
          ),
      ),
  );
}
