import { NativeSessionSchema, parse, parseEvent, ThreadSchema } from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import { type DomainState, entityId } from "./projectors.js";

/** Called by the trusted runtime host only after the provider has opened the session. */
export function adoptNativeSession(
  state: DomainState,
  request: { session: unknown; profileId: string; threadId: string; confirmed: boolean },
  context: CommandContext,
): Outcome {
  if (!request.confirmed || context.actor.kind !== "human")
    throw new Error("adoption_confirmation_required");
  const session = parse(NativeSessionSchema, request.session);
  const profile = state.agent?.find((row) => row.id === request.profileId && !row.archived);
  if (!profile) throw new Error("profile_unavailable");
  const definition = state.agentDefinition?.find((row) => row.id === profile.definitionId);
  if (!definition || definition.adapter !== session.provider)
    throw new Error("profile_provider_mismatch");
  if (session.missing) throw new Error("native_session_missing");
  const previous = state.nativeSession?.find(
    (row) => row.provider === session.provider && row.nativeId === session.nativeId,
  );
  if (previous?.adopted || previous?.threadId) {
    const linked = state.thread?.find((row) => row.id === previous.threadId);
    if (!linked || linked.agentId !== request.profileId)
      throw new Error("native_session_already_adopted");
    return { events: [], result: linked };
  }
  if (state.thread?.some((row) => row.id === request.threadId))
    throw new Error("thread_already_exists");
  const thread = parse(ThreadSchema, {
    id: request.threadId,
    agentId: request.profileId,
    kind: "main",
    title: session.title ?? "Adopted session",
    titleSource: session.title ? "provider" : "auto",
    pinned: false,
    archived: false,
    createdAt: context.at,
    lastActivityAt: context.at,
  });
  const linked = parse(NativeSessionSchema, {
    ...session,
    adopted: true,
    threadId: thread.id,
    lastSeenAt: context.at,
  });
  const audit = {
    id: `audit:${context.commandId}`,
    actor: context.actor,
    action: "native.adopt",
    target: thread.id,
    result: "allowed",
    detail: { provider: session.provider, nativeId: session.nativeId },
    at: context.at,
  };
  const events = (
    [
      ["thread", thread, "created"],
      ["nativeSession", linked, previous ? "updated" : "created"],
      ["audit", audit, "created"],
    ] as const
  ).map(([kind, value, verb], index) =>
    parseEvent({
      eventId: `${context.commandId}:${index}`,
      commandId: context.commandId,
      aggregateType: kind,
      aggregateId: entityId(kind, value),
      type: `${kind}.${verb}`,
      occurredAt: context.at,
      payload: value,
    }),
  );
  return { events, result: thread };
}
