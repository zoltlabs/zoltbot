import { isDeepStrictEqual } from "node:util";
import type { DomainState } from "@zoltbot/core";
import {
  compareSessions,
  type ForkBoundary,
  type ForkProvenance,
  parse,
  SessionSchema,
  ThreadSchema,
} from "@zoltbot/protocol";

export const operationKey = (id: string) => `fork.operation.${id}`;
export const historyKey = (id: string) => `fork.history.${id}`;
export function forkSource(state: DomainState, id: string, boundary: ForkBoundary, native = true) {
  assertForkRunnable(state, id);
  const thread = parse(
    ThreadSchema,
    state.thread?.find((r) => r.id === id && !r.archived),
  );
  const session = parse(
    SessionSchema,
    (state.session ?? [])
      .filter((r) => r.threadId === id && (!native || r.nativeId))
      .sort(compareSessions)[0],
  );
  const caps = session.capabilities as {
    nativeFork?: { latest?: boolean; boundaries?: string[]; activation?: string };
  };
  if (native && (!caps.nativeFork?.latest || caps.nativeFork.activation === "deferred"))
    throw Error("native_fork_unverified");
  if (native && boundary.kind !== "latest" && !caps.nativeFork?.boundaries?.includes(boundary.kind))
    throw Error("historical_fork_unavailable");
  if (
    session.state === "starting" ||
    session.state === "running" ||
    session.endReason === "runtime_cleanup_required"
  )
    throw Error("fork_requires_idle");
  if ((session.background ?? []).some((r) => r.state === "running"))
    throw Error("fork_requires_idle");
  if ((state.turn ?? []).some((r) => r.threadId === id && r.status === "running"))
    throw Error("fork_requires_idle");
  if ((state.interaction ?? []).some((r) => r.threadId === id && r.state === "pending"))
    throw Error("fork_requires_idle");
  if (
    (state.item ?? []).some(
      (r) =>
        r.threadId === id &&
        r.kind === "user" &&
        ["queued", "sending", "uncertain"].includes(
          String((r.body as Record<string, unknown>)?.queueState),
        ),
    )
  )
    throw Error("fork_requires_idle");
  const lineage = new Set(
    (state.session ?? [])
      .filter(
        (r) =>
          r.threadId === id &&
          r.nativeId === session.nativeId &&
          r.provider === session.provider &&
          r.cwd === session.cwd,
      )
      .map((r) => r.id),
  );
  const turns = (state.turn ?? []).filter((r) => r.threadId === id && lineage.has(r.sessionId));
  if (native && !turns.length && !thread.fork) throw Error("fork_history_unavailable");
  const turn =
    boundary.kind === "latest"
      ? undefined
      : turns.find((r) => r.id === boundary.turnId && r.status === "completed" && r.nativeTurnId);
  if (boundary.kind !== "latest" && !turn) throw Error("fork_boundary_unavailable");
  return { thread, session, nativeBoundary: turn?.nativeTurnId as string | undefined };
}
export function forkPending(state: DomainState, threadId: string) {
  const thread = state.thread?.find((r) => r.id === threadId);
  const fork = thread?.fork as ForkProvenance | undefined;
  if (!fork) return false;
  const op = state.settings?.find((r) => r.key === operationKey(fork.operationId))?.value as
    | { state?: string }
    | undefined;
  return op?.state !== "ready";
}
export function assertForkRunnable(state: DomainState, threadId: string) {
  if (forkPending(state, threadId)) throw Error("fork_needs_reconciliation");
}
/** Fence both the source and child scope while credentials/native startup yield. */
export function forkFence(state: DomainState, sourceId: string, childId: string) {
  const pick = (s: DomainState) =>
    Object.fromEntries(
      [
        "thread",
        "agent",
        "agentDefinition",
        "project",
        "subproject",
        "compareMember",
        "grant",
        "workspace",
      ].map((k) => [k, s[k]]),
    );
  const initial = structuredClone(pick(state));
  const sourceSession = (s: DomainState) =>
    (s.session ?? [])
      .filter((r) => r.threadId === sourceId)
      .map(({ id, nativeId, state, cwd, provider }) => ({ id, nativeId, state, cwd, provider }));
  const initialSessions = structuredClone(sourceSession(state));
  return (current: DomainState) => {
    if (
      !isDeepStrictEqual(initial, pick(current)) ||
      !isDeepStrictEqual(initialSessions, sourceSession(current))
    )
      throw Error("fork_configuration_changed");
    if (
      !current.thread?.some((r) => r.id === childId && !r.archived) ||
      !current.thread?.some((r) => r.id === sourceId && !r.archived)
    )
      throw Error("fork_configuration_changed");
  };
}
