import { NativeCompactionBodySchema, parse } from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { applyEvents, type DomainState } from "./projectors.js";
export function requestNativeCompaction(
  state: DomainState,
  sessionId: string,
  itemId: string,
  attemptId: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_compaction_required");
  const session = state.session?.find((row) => row.id === sessionId);
  const thread = state.thread?.find((row) => row.id === session?.threadId && !row.archived);
  if (!session || !thread) throw new Error("runtime_session_unavailable");
  const capabilities = session.capabilities as
    | { compaction?: { manual?: boolean; events?: boolean } }
    | undefined;
  if (!capabilities?.compaction?.manual) throw new Error("unsupported_compaction");
  if (
    session.state !== "ready" ||
    state.turn?.some((row) => row.sessionId === sessionId && row.status === "running")
  )
    throw new Error("compaction_requires_idle");
  for (const row of state.item ?? []) {
    if (row.kind !== "note") continue;
    const body = row.body as Record<string, unknown> | undefined;
    if (
      body?.code === "manual_compaction" &&
      (body.sessionId === sessionId ||
        (row.threadId === thread.id && body.state === "uncertain")) &&
      body.state !== "completed"
    )
      throw new Error("compaction_review_or_wait_required");
  }
  const body = parse(NativeCompactionBodySchema, {
    code: "manual_compaction",
    operationVersion: 1,
    sessionId,
    attemptId,
    expectsEvent: capabilities.compaction.events === true,
    state: "sending",
  });
  const created = handle(
    state,
    {
      type: "create",
      kind: "item",
      value: {
        id: itemId,
        threadId: thread.id,
        seq:
          (state.item ?? []).reduce(
            (n, row) => (row.threadId === thread.id ? Math.max(n, Number(row.seq)) : n),
            0,
          ) + 1,
        kind: "note",
        body,
        createdAt: context.at,
        updatedAt: context.at,
      },
    },
    context,
  );
  const audit = handle(
    applyEvents(state, created.events),
    {
      type: "create",
      kind: "audit",
      value: {
        id: `audit:${context.commandId}`,
        actor: context.actor,
        action: "session.compact",
        target: sessionId,
        result: "allowed",
        detail: {},
        at: context.at,
      },
    },
    context,
  );
  return {
    events: [...created.events, ...audit.events].map((row, index) => ({
      ...row,
      eventId: `${context.commandId}:${index}`,
    })),
    result: { id: itemId, sessionId, attemptId, kind: "compact" },
  };
}
export function settleNativeCompaction(
  state: DomainState,
  id: string,
  attemptId: string,
  status: "acknowledged" | "uncertain" | "completed",
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_compaction_writer_required");
  const item = state.item?.find((row) => row.id === id && row.kind === "note");
  if (!item) throw new Error("compaction_not_found");
  const body = parse(NativeCompactionBodySchema, item.body);
  const session = state.session?.find(
    (row) => row.id === body.sessionId && row.threadId === item.threadId,
  );
  if (!session || body.attemptId !== attemptId) throw new Error("compaction_attempt_conflict");
  if (body.state === "completed") return { events: [], result: { id, state: "completed" } };
  if (!["sending", "acknowledged"].includes(body.state))
    throw new Error("compaction_attempt_conflict");
  const completed = status === "completed" || (status === "acknowledged" && !body.expectsEvent);
  const next = parse(NativeCompactionBodySchema, {
    ...body,
    state: completed ? "completed" : status,
    ...(completed ? { confirmation: status === "completed" ? "native_event" : "native_ack" } : {}),
    ...(status === "uncertain" ? { errorCode: "delivery_uncertain" } : {}),
  });
  return handle(state, { type: "update", kind: "item", id, changes: { body: next } }, context);
}
