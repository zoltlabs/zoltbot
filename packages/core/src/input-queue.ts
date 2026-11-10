import {
  type ArtifactTarget,
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  type OutputMode,
  parse,
  parseEvent,
  type QueuedInputBody,
  QueuedInputBodySchema,
  type UserInput,
  UserInputSchema,
} from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

function event(
  kind: EntityKind,
  value: Record<string, unknown>,
  context: CommandContext,
  verb: string,
  index: number,
): DomainEvent {
  parse(entitySchemas[kind], value);
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    commandId: context.commandId,
    aggregateType: kind,
    aggregateId: String(value.id ?? value.key),
    type: `${kind}.${verb}`,
    occurredAt: context.at,
    payload: value,
  });
}
function queueInput(
  state: DomainState,
  input: {
    threadId: string;
    outputMode?: OutputMode;
    artifactTarget?: ArtifactTarget;
    input: UserInput;
    mode: "queue" | "steer";
    sourceInteractionId?: string;
  },
  itemId: string,
  context: CommandContext,
): Outcome {
  parse(UserInputSchema, input.input);
  if (input.artifactTarget && (input.mode !== "queue" || context.actor.kind !== "human"))
    throw new Error("artifact_target_queue_required");
  if (
    input.input.some((part) =>
      part.type === "file"
        ? !part.path
        : part.type === "image" && !part.path && (!part.base64 || !part.mimeType),
    )
  )
    throw new Error("invalid_attachment");
  if (!input.input.some((part) => part.type !== "text" || part.text.trim().length))
    throw new Error("empty_input");
  const thread = state.thread?.find((row) => row.id === input.threadId && !row.archived);
  if (!thread) throw new Error("thread_unavailable");
  if (state.item?.some((row) => row.id === itemId)) throw new Error("item_already_exists");
  const body = parse(QueuedInputBodySchema, {
    queueVersion: 1,
    ...(input.outputMode ? { outputMode: input.outputMode } : {}),
    ...(input.artifactTarget ? { artifactTarget: input.artifactTarget } : {}),
    ...(context.actor.kind === "agent" ? { origin: "agent" } : {}),
    ...(context.actor.kind === "system" ? { origin: "system" } : {}),
    input: structuredClone(input.input),
    mode: input.mode,
    queueState: "queued",
    ...(input.sourceInteractionId ? { sourceInteractionId: input.sourceInteractionId } : {}),
  });
  const item = {
    id: itemId,
    threadId: thread.id,
    kind: "user",
    seq:
      (state.item ?? []).reduce(
        (highest, row) =>
          row.threadId === thread.id ? Math.max(highest, Number(row.seq)) : highest,
        0,
      ) + 1,
    body,
    createdAt: context.at,
    updatedAt: context.at,
  };
  return {
    events: [
      event("item", item, context, "created", 0),
      event("thread", { ...thread, lastActivityAt: context.at }, context, "updated", 1),
    ],
    result: { id: itemId, disposition: "queued" },
  };
}
function queuedItem(state: DomainState, id: string) {
  const item = state.item?.find((row) => row.id === id && row.kind === "user");
  if (!item) throw new Error("input_not_found");
  return { item, body: parse(QueuedInputBodySchema, item.body) };
}
export function claimQueuedInput(
  state: DomainState,
  id: string,
  sessionId: string,
  attemptId: string,
  context: CommandContext,
  browserGuidance?: { bindingId: string; digest: string },
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_input_writer_required");
  const { item, body } = queuedItem(state, id);
  if (body.queueState !== "queued") throw new Error("input_not_queued");
  if (body.artifactTarget && (body.mode !== "queue" || body.origin === "agent"))
    throw new Error("artifact_target_queue_required");
  const thread = state.thread?.find((row) => row.id === item.threadId && !row.archived);
  const session = state.session?.find(
    (row) => row.id === sessionId && row.threadId === item.threadId,
  );
  if (!thread || !session || !["ready", "running"].includes(String(session.state)))
    throw new Error("input_session_unavailable");
  const caps =
    session.capabilities && typeof session.capabilities === "object"
      ? (session.capabilities as Record<string, unknown>)
      : {};
  const busy =
    session.state === "running" ||
    state.turn?.some((turn) => turn.threadId === item.threadId && turn.status === "running");
  const deliveryMode = body.mode === "steer" && caps.steer === "native" && busy ? "steer" : "queue";
  if (busy && deliveryMode !== "steer") throw new Error("thread_busy");
  const { errorCode: _hold, ...ready } = body;
  const next = parse(QueuedInputBodySchema, {
    ...ready,
    queueVersion: 1,
    queueState: "sending",
    sessionId,
    attemptId,
    attemptedAt: context.at,
    ...(browserGuidance ? { browserGuidance } : {}),
    deliveryMode,
  });
  return {
    events: [event("item", { ...item, body: next, updatedAt: context.at }, context, "updated", 0)],
    result: { id, input: next.input, deliveryMode, attemptId },
  };
}
export function settleQueuedInput(
  state: DomainState,
  id: string,
  attemptId: string,
  result: {
    state: "sent" | "handled" | "failed" | "uncertain";
    turnId?: string;
    errorCode?: QueuedInputBody["errorCode"];
  },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_input_writer_required");
  const { item, body } = queuedItem(state, id);
  if (body.queueState !== "sending" || body.attemptId !== attemptId)
    throw new Error("input_attempt_conflict");
  if (result.turnId) {
    const turn = state.turn?.find((row) => row.id === result.turnId);
    if (
      !turn ||
      turn.sessionId !== body.sessionId ||
      turn.threadId !== item.threadId ||
      result.state !== "sent"
    )
      throw new Error("input_turn_mismatch");
  }
  const next = parse(QueuedInputBodySchema, {
    ...body,
    queueState: result.state,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  });
  return {
    events: [
      event(
        "item",
        {
          ...item,
          ...(result.turnId ? { turnId: result.turnId } : {}),
          body: next,
          updatedAt: context.at,
        },
        context,
        "updated",
        0,
      ),
    ],
    result: { id, state: result.state },
  };
}

/** Link observed native start evidence even when acknowledgement arrived first. */
export function linkQueuedInputTurn(
  state: DomainState,
  id: string,
  attemptId: string,
  turnId: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_input_writer_required");
  const { item, body } = queuedItem(state, id);
  if (body.attemptId !== attemptId || !["sending", "sent"].includes(body.queueState))
    throw new Error("input_attempt_conflict");
  const turn = state.turn?.find((row) => row.id === turnId);
  if (
    !turn ||
    turn.sessionId !== body.sessionId ||
    turn.threadId !== item.threadId ||
    (item.turnId !== undefined && item.turnId !== turnId)
  )
    throw new Error("input_turn_mismatch");
  if (item.turnId === turnId && body.queueState === "sent")
    return { events: [], result: { id, state: "sent" } };
  return {
    events: [
      event(
        "item",
        {
          ...item,
          turnId,
          body: parse(QueuedInputBodySchema, { ...body, queueState: "sent" }),
          updatedAt: context.at,
        },
        context,
        "updated",
        0,
      ),
    ],
    result: { id, state: "sent" },
  };
}

/** A proven preflight rejection is different from an uncertain native delivery. */
export function rejectQueuedInput(
  state: DomainState,
  id: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_input_writer_required");
  const { item, body } = queuedItem(state, id);
  if (body.queueState !== "queued") throw new Error("input_not_queued");
  const next = parse(QueuedInputBodySchema, {
    ...body,
    queueVersion: 1,
    queueState: "failed",
    errorCode: "invalid_input",
  });
  return {
    events: [event("item", { ...item, body: next, updatedAt: context.at }, context, "updated", 0)],
    result: { id, state: "failed" },
  };
}

export function cancelQueuedInput(
  state: DomainState,
  threadId: string,
  id: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_input_required");
  const { item, body } = queuedItem(state, id);
  if (item.threadId !== threadId) throw new Error("input_thread_conflict");
  if (body.queueState !== "queued") throw new Error("input_not_queued");
  const next = parse(QueuedInputBodySchema, {
    ...body,
    queueVersion: 1,
    queueState: "failed",
    errorCode: "cancelled",
  });
  return {
    events: [
      event("item", { ...item, body: next, updatedAt: context.at }, context, "updated", 0),
      event(
        "audit",
        {
          id: `audit:${context.commandId}`,
          actor: context.actor,
          action: "turn.cancelQueued",
          target: id,
          result: "allowed",
          detail: { threadId },
          at: context.at,
        },
        context,
        "created",
        1,
      ),
    ],
    result: { kind: "cancel_input", id, threadId, ok: true },
  };
}

/** D122: the task runner hands a task thread its brief, feedback or restart note. */
export function queueTaskInput(
  state: DomainState,
  taskId: string,
  text: string,
  itemId: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system" && context.actor.kind !== "human")
    throw new Error("task_input_actor_required");
  const task = state.task?.find((row) => row.id === taskId);
  const thread = state.thread?.find((row) => row.id === task?.threadId && !row.archived);
  if (!task || !thread || thread.taskId !== taskId) throw new Error("task_thread_unavailable");
  const queued = queueInput(
    state,
    {
      threadId: String(thread.id),
      input: [{ type: "text", text }],
      mode: "queue",
      ...(task.outputMode ? { outputMode: task.outputMode as OutputMode } : {}),
    },
    itemId,
    context,
  );
  if (!task.sourceMessageId) return queued;
  const source = state.message?.find(
    (r) => r.id === task.sourceMessageId && r.thread === thread.id,
  );
  if (!source || source.origin !== "agent") throw Error("assignment_source_unavailable");
  return {
    ...queued,
    events: queued.events.map((event) =>
      event.aggregateType !== "item"
        ? event
        : {
            ...event,
            payload: {
              ...(event.payload as object),
              body: {
                ...(event.payload as { body: object }).body,
                origin: "agent",
                sourceMessageId: task.sourceMessageId,
              },
            },
          },
    ),
  };
}
/** A daemon notice that starts a turn on its own, such as the main agent's wake-up. */
export function queueSystemNotice(
  state: DomainState,
  input: { threadId: string; text: string },
  itemId: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_input_writer_required");
  return queueInput(
    state,
    { threadId: input.threadId, input: [{ type: "text", text: input.text }], mode: "queue" },
    itemId,
    context,
  );
}
export function queueHumanInput(...args: Parameters<typeof queueInput>): Outcome {
  if (args[3].actor.kind !== "human") throw new Error("human_input_required");
  return queueInput(...args);
}
export function queueAgentInput(
  state: DomainState,
  messageId: string,
  itemId: string,
  context: CommandContext,
): Outcome {
  const message = state.message?.find((row) => row.id === messageId);
  const from = message?.from as { kind?: string; id?: string } | undefined;
  const thread = state.thread?.find((row) => row.id === message?.thread && !row.archived);
  if (
    !message ||
    !thread ||
    context.actor.kind !== "agent" ||
    from?.kind !== "agent" ||
    from.id !== context.actor.id ||
    message.origin !== "agent"
  )
    throw new Error("invalid_peer_input");
  const body = message.body as { type: string; text?: string }[];
  if (
    !Array.isArray(body) ||
    body.some((part) => part.type !== "text" || typeof part.text !== "string")
  )
    throw new Error("invalid_peer_input");
  const out = queueInput(
    state,
    { threadId: String(thread.id), input: body as UserInput, mode: "queue" },
    itemId,
    context,
  );
  return {
    ...out,
    events: out.events.map((row) =>
      row.aggregateType === "item"
        ? {
            ...row,
            payload: {
              ...(row.payload as Record<string, unknown>),
              body: { ...(row.payload as { body: object }).body, sourceMessageId: messageId },
            },
          }
        : row,
    ),
  };
}
