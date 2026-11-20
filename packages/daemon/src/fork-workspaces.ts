import type { DomainState } from "@zoltbot/core";
import type { ForkProvenance } from "@zoltbot/protocol";
/** A folder shared with a native fork has one dispatcher, including the pre-turn send window. */
export function forkWorkspaceBusy(
  state: DomainState,
  threadId: string,
  sessionId: string,
): boolean {
  // C2: an aside is read-only, so it neither waits for the folder nor holds it.
  const aside = (id: unknown) => state.thread?.some((r) => r.id === id && r.kind === "aside");
  if (aside(threadId)) return false;
  const session = state.session?.find((r) => r.id === sessionId);
  if (
    !session?.cwd ||
    !state.thread?.some(
      (r) => r.kind !== "aside" && (r.fork as ForkProvenance | undefined)?.cwd === session.cwd,
    )
  )
    return false;
  const others = (state.session ?? []).filter(
    (r) =>
      r.threadId !== threadId &&
      !aside(r.threadId) &&
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
