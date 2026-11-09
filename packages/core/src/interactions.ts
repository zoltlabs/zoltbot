import {
  assertNoPrivateValue,
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  HOST_WORKSPACE_REF,
  type InteractionAnswer,
  InteractionDraftSchema,
  parse,
  parseEvent,
  privateAnswerValues,
  publicAnswerData,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { applyEvents, type DomainState, entityId } from "./projectors.js";
import { ROUTINE_PERMISSION_TIMEOUT_MS } from "./routine-policy.js";

function append(
  events: DomainEvent[],
  kind: EntityKind,
  value: Record<string, unknown>,
  verb: string,
  context: CommandContext,
) {
  parse(entitySchemas[kind], value);
  events.push(
    parseEvent({
      eventId: `${context.commandId}:${events.length}`,
      commandId: context.commandId,
      aggregateType: kind,
      aggregateId: entityId(kind, value),
      type: `${kind}.${verb}`,
      occurredAt: context.at,
      payload: value,
    }),
  );
}
export function requestInteraction(
  state: DomainState,
  input: unknown,
  itemId: string,
  context: CommandContext,
): Outcome {
  const draft = parse(InteractionDraftSchema, input);
  if (new Set(draft.items.map((item) => item.id)).size !== draft.items.length)
    throw new Error("duplicate_interaction_item");
  const thread = state.thread?.find((row) => row.id === draft.threadId);
  if (!thread || thread.agentId !== draft.agentId) throw new Error("interaction_thread_mismatch");
  if (state.interaction?.some((row) => row.id === draft.id))
    throw new Error("interaction_already_exists");
  if (state.item?.some((row) => row.id === itemId)) throw new Error("item_already_exists");
  const task = state.task?.find((row) => row.id === thread.taskId);
  const { timeout: _providerTimeout, ...unattended } = draft;
  const interaction = {
    ...(task?.routineOccurrenceId ? unattended : draft),
    state: "pending",
    version: 1,
    createdAt: context.at,
  };
  const seq =
    (state.item ?? []).reduce(
      (highest, row) =>
        row.threadId === draft.threadId ? Math.max(highest, Number(row.seq)) : highest,
      0,
    ) + 1;
  const events: DomainEvent[] = [];
  append(events, "interaction", interaction, "created", context);
  const occurrence = state.routineOccurrence?.find((row) => row.id === task?.routineOccurrenceId);
  if (occurrence && ["queued", "started"].includes(String(occurrence.status)))
    append(
      events,
      "routineOccurrence",
      {
        ...occurrence,
        outcome: "needs_you",
        permissionDeadline:
          occurrence.permissionDeadline ??
          new Date(Date.parse(context.at) + ROUTINE_PERMISSION_TIMEOUT_MS).toISOString(),
        updatedAt: context.at,
      },
      "updated",
      context,
    );
  append(
    events,
    "item",
    {
      id: itemId,
      threadId: draft.threadId,
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      seq,
      kind: "interaction",
      body: { interactionId: draft.id },
      createdAt: context.at,
      updatedAt: context.at,
    },
    "created",
    context,
  );
  return { events, result: interaction };
}
export function expireInteractions(
  state: DomainState,
  threadIds: readonly string[],
  reason: "process_died" | "turn_ended" | "provider_cleared" | "daemon_restart" | "timeout",
  context: CommandContext,
  sessionId?: string,
): Outcome {
  const selected = new Set(threadIds),
    events: DomainEvent[] = [];
  for (const interaction of state.interaction ?? []) {
    if (!selected.has(String(interaction.threadId)) || interaction.state !== "pending") continue;
    if (interaction.nativeRef === HOST_WORKSPACE_REF && reason !== "timeout") continue;
    append(
      events,
      "interaction",
      {
        ...interaction,
        state: "expired",
        version: Number(interaction.version) + 1,
        resolvedAt: context.at,
        resolution: {
          action: "expire",
          by: context.actor,
          at: context.at,
          automatic: true,
          feedback: reason,
        },
      },
      "expired",
      context,
    );
  }
  if (sessionId) {
    const session = state.session?.find((row) => row.id === sessionId);
    if (!session || !selected.has(String(session.threadId)))
      throw new Error("interaction_session_mismatch");
    if (!["closed", "failed"].includes(String(session.state)))
      append(
        events,
        "session",
        { ...session, state: "closed", endedAt: context.at },
        "updated",
        context,
      );
  }
  return {
    events,
    result: { expired: events.filter((event) => event.aggregateType === "interaction").length },
  };
}
export function answerInteractions(
  initial: DomainState,
  items: readonly { id: string; version: number; answer: InteractionAnswer }[],
  context: CommandContext,
): Outcome {
  if (
    !items.length ||
    items.length > 100 ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new Error("invalid_interaction_batch");
  const fields = items.map((item) => ({
    request: {
      items: (initial.interaction?.find((row) => row.id === item.id)?.items ?? []) as {
        id: string;
        secret?: boolean;
      }[],
    },
    answer: item.answer,
  }));
  const privateValues = new Set(
    fields.flatMap(({ request, answer }) => [...privateAnswerValues(request, answer)]),
  );
  for (const { request, answer } of fields)
    assertNoPrivateValue(publicAnswerData(request, answer), privateValues);
  let state = initial;
  const events: DomainEvent[] = [],
    results: Record<string, unknown>[] = [];
  for (const item of items) {
    const outcome = handle(
      state,
      { type: "answer", ...item },
      { ...context, commandId: `${context.commandId}:step:${events.length}` },
    );
    events.push(...outcome.events);
    results.push(outcome.result);
    state = applyEvents(state, outcome.events);
  }
  return {
    events: events.map((event, index) => ({
      ...event,
      eventId: `${context.commandId}:${index}`,
      commandId: context.commandId,
    })),
    result: { results },
  };
}
export function deferInteraction(state: DomainState, id: string, context: CommandContext): Outcome {
  const request = state.interaction?.find((row) => row.id === id && row.state === "pending");
  if (!request) throw new Error("interaction_not_pending");
  if (context.actor.kind !== "human") throw new Error("human_defer_required");
  const previous = state.settings?.find((row) => row.key === "interaction.deferred");
  const pending = new Set(
    (state.interaction ?? []).filter((row) => row.state === "pending").map((row) => row.id),
  );
  const order = Array.isArray(previous?.value)
    ? previous.value.filter(
        (value) => typeof value === "string" && value !== id && pending.has(value),
      )
    : [];
  const value = [...order, id];
  return handle(
    state,
    previous
      ? { type: "update", kind: "settings", id: "interaction.deferred", changes: { value } }
      : { type: "create", kind: "settings", value: { key: "interaction.deferred", value } },
    context,
  );
}
