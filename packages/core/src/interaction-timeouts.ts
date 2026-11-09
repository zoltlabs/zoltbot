import {
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  type InteractionAnswer,
  InteractionSchema,
  parse,
  parseEvent,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { type DomainState, entityId } from "./projectors.js";

export function timeoutInteraction(
  state: DomainState,
  id: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_timeout_required");
  const row = state.interaction?.find((row) => row.id === id);
  if (!row) throw new Error("interaction_not_found");
  const request = parse(InteractionSchema, row);
  const timeout = request.timeout;
  const now = Date.parse(context.at);
  const deadline = Date.parse(request.createdAt) + (timeout?.seconds ?? 0) * 1000;
  if (
    request.state !== "pending" ||
    !timeout ||
    !Number.isFinite(deadline) ||
    !Number.isFinite(now) ||
    now < deadline
  )
    return { events: [], result: { action: "none" } };
  let answer: InteractionAnswer | undefined;
  if (timeout.onTimeout === "reject" && request.type === "approval")
    answer = { action: "decline", by: context.actor, at: context.at, automatic: true };
  if (
    timeout.onTimeout === "use_default" &&
    request.type === "question" &&
    request.items.every(
      (item) =>
        !item.secret &&
        item.default !== undefined &&
        item.options?.some((option) => option.id === item.default),
    )
  )
    answer = {
      action: "accept",
      by: context.actor,
      at: context.at,
      automatic: true,
      answers: Object.fromEntries(
        request.items.map((item) => [item.id, { options: [item.default as string] }]),
      ),
    };
  if (answer) {
    const outcome = handle(
      state,
      { type: "answer", id, version: request.version, answer },
      context,
    );
    return { ...outcome, result: { action: "answer", interaction: outcome.result } };
  }
  const events: DomainEvent[] = [];
  const append = (kind: EntityKind, value: Record<string, unknown>, verb: string) => {
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
  };
  append(
    "interaction",
    {
      ...request,
      state: "expired",
      version: request.version + 1,
      resolvedAt: context.at,
      resolution: {
        action: "expire",
        by: context.actor,
        at: context.at,
        automatic: true,
        feedback: "interaction_timeout",
      },
    },
    "expired",
  );
  const task = state.task?.find((task) => task.id === request.taskId);
  if (task?.state === "running")
    append(
      "task",
      { ...task, state: "blocked", holdReason: "interaction_timeout", updatedAt: context.at },
      "updated",
    );
  const turn = state.turn?.find((turn) => turn.id === request.turnId);
  if (turn?.status === "running")
    append(
      "turn",
      { ...turn, status: "interrupted", endedAt: context.at, stopReason: "interaction_timeout" },
      "updated",
    );
  return {
    events,
    result: {
      action: "park",
      interactionId: id,
      threadId: request.threadId,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.turnId ? { turnId: request.turnId } : {}),
    },
  };
}
