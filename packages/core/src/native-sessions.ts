import { NativeSessionSchema, parse, parseEvent } from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import { type DomainState, entityId } from "./projectors.js";

/** Apply only a complete, successful listing. Failed or partial pages must never reach this function. */
export function reconcileNativeSessions(
  initial: DomainState,
  provider: string,
  input: readonly unknown[],
  context: CommandContext,
  filter: { cwd?: string } = {},
): Outcome {
  const sessions = input.map((value) => parse(NativeSessionSchema, value));
  const seen = new Set<string>();
  for (const session of sessions) {
    if (session.provider !== provider) throw new Error("native_provider_mismatch");
    if (filter.cwd !== undefined && session.cwd !== filter.cwd)
      throw new Error("native_cwd_mismatch");
    if (seen.has(session.nativeId)) throw new Error("duplicate_native_session");
    seen.add(session.nativeId);
  }
  const events: Outcome["events"] = [];
  function save(value: Record<string, unknown>, existing: boolean) {
    parse(NativeSessionSchema, value);
    events.push(
      parseEvent({
        eventId: `${context.commandId}:${events.length}`,
        commandId: context.commandId,
        aggregateType: "nativeSession",
        aggregateId: entityId("nativeSession", value),
        type: existing ? "nativeSession.updated" : "nativeSession.created",
        occurredAt: context.at,
        payload: value,
      }),
    );
  }
  for (const session of sessions) {
    const previous = initial.nativeSession?.find(
      (row) => row.provider === provider && row.nativeId === session.nativeId,
    );
    const { adopted: _adopted, threadId: _threadId, ...metadata } = session;
    save(
      {
        ...previous,
        ...metadata,
        adopted: previous?.adopted ?? false,
        ...(previous?.threadId ? { threadId: previous.threadId } : {}),
        missing: false,
        lastSeenAt: context.at,
      },
      previous !== undefined,
    );
  }
  for (const previous of initial.nativeSession ?? []) {
    if (previous.provider !== provider || seen.has(String(previous.nativeId)) || previous.missing)
      continue;
    if (filter.cwd !== undefined && previous.cwd !== filter.cwd) continue;
    save({ ...previous, missing: true }, true);
  }
  return {
    events: events.map((event, index) => ({
      ...event,
      eventId: `${context.commandId}:${index}`,
      commandId: context.commandId,
    })),
    result: { provider, seen: sessions.length },
  };
}
