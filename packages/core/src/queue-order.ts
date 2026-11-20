// C1: the owner reorders queued messages or sends one now. Queue order is `queuePosition` when set,
// else `seq` (items keep their seq, which is unique per thread). Both commands fail with
// `queue_changed` when the queue no longer matches what the owner saw, so the client refreshes.
import {
  entitySchemas,
  parse,
  parseEvent,
  type QueuedInputBody,
  QueuedInputBodySchema,
  queueOrderKey,
} from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

type Row = Record<string, unknown>;

/** The thread's queued user items, first to be sent first. */
export function queuedItems(state: DomainState, threadId: string): Row[] {
  return (state.item ?? [])
    .filter(
      (row) =>
        row.threadId === threadId &&
        row.kind === "user" &&
        (row.body as { queueState?: unknown } | undefined)?.queueState === "queued",
    )
    .sort((a, b) => queueOrderKey(a) - queueOrderKey(b) || Number(a.seq) - Number(b.seq));
}

function owner(state: DomainState, threadId: string, context: CommandContext) {
  if (context.actor.kind !== "human") throw new Error("human_input_required");
  if (!state.thread?.some((row) => row.id === threadId && !row.archived))
    throw new Error("thread_unavailable");
}

function updated(item: Row, body: QueuedInputBody, context: CommandContext, index: number) {
  const value = { ...item, body: parse(QueuedInputBodySchema, body), updatedAt: context.at };
  parse(entitySchemas.item, value);
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    commandId: context.commandId,
    aggregateType: "item",
    aggregateId: String(item.id),
    type: "item.updated",
    occurredAt: context.at,
    payload: value,
  });
}

/** Gives the queued items the owner's order, reusing the positions they hold now. */
function ordered(
  queued: Row[],
  order: string[],
  context: CommandContext,
  change: (id: string, body: QueuedInputBody) => QueuedInputBody = (_id, body) => body,
) {
  const keys = queued.map(queueOrderKey);
  const byId = new Map(queued.map((row) => [String(row.id), row]));
  const events = [];
  for (const [index, id] of order.entries()) {
    const item = byId.get(id) as Row;
    const before = parse(QueuedInputBodySchema, item.body);
    const body = change(id, { ...before, queuePosition: keys[index] as number });
    if (JSON.stringify(body) !== JSON.stringify(before))
      events.push(updated(item, body, context, events.length));
  }
  return events;
}

export function reorderQueuedInput(
  state: DomainState,
  threadId: string,
  order: string[],
  context: CommandContext,
): Outcome {
  owner(state, threadId, context);
  const queued = queuedItems(state, threadId);
  const current = queued.map((row) => String(row.id));
  if (
    order.length !== current.length ||
    new Set(order).size !== order.length ||
    !order.every((id) => current.includes(id))
  )
    throw new Error("queue_changed");
  return {
    events: ordered(queued, order, context),
    result: { kind: "queue_order", threadId, order },
  };
}

/** Whether the thread's live session takes steering while a turn runs. */
function steersNatively(state: DomainState, threadId: string) {
  return (state.session ?? []).some(
    (row) =>
      row.threadId === threadId &&
      ["ready", "running"].includes(String(row.state)) &&
      (row.capabilities as { steer?: unknown } | undefined)?.steer === "native",
  );
}

export function sendQueuedInputNow(
  state: DomainState,
  threadId: string,
  id: string,
  context: CommandContext,
): Outcome {
  owner(state, threadId, context);
  const queued = queuedItems(state, threadId);
  const item = queued.find((row) => row.id === id);
  if (!item) throw new Error("queue_changed");
  const body = parse(QueuedInputBodySchema, item.body);
  const running = state.turn?.some((row) => row.threadId === threadId && row.status === "running");
  // An artifact revision must wait its turn (artifact_target_queue_required), so it only moves.
  const steer = !!running && !body.artifactTarget && steersNatively(state, threadId);
  const order = [id, ...queued.map((row) => String(row.id)).filter((other) => other !== id)];
  return {
    events: ordered(queued, order, context, (target, next) =>
      target === id && steer ? { ...next, mode: "steer" } : next,
    ),
    result: { kind: "queue_send_now", threadId, id, delivery: steer ? "steer" : "next" },
  };
}
