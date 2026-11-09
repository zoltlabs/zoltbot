import {
  AgentEventSchema,
  type BackgroundTask,
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  parse,
  parseEvent,
} from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import { expireInteractions } from "./interactions.js";
import { settleNativeCompaction } from "./native-compaction.js";
import type { DomainState } from "./projectors.js";
import { applyEvents } from "./projectors.js";

/** Matches SessionSchema.background maxItems: the oldest finished entries fall off first. */
export const backgroundTaskLimit = 50;
export interface RuntimeEventInput {
  sessionId: string;
  threadId: string;
  event: unknown;
  itemId?: string;
  turnId?: string;
  origin?: "human" | "agent" | "system";
  /** Local cleanup is not proof that the provider acknowledged a command. */
  synthetic?: true;
  /** A timeout owner expires these requests after native stop confirmation. */
  heldInteractionIds?: readonly string[];
}
export function observeRuntimeEvent(
  state: DomainState,
  input: RuntimeEventInput,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_runtime_writer_required");
  const event = parse(AgentEventSchema, input.event);
  const session = state.session?.find((row) => row.id === input.sessionId);
  const thread = state.thread?.find((row) => row.id === input.threadId);
  if (!session || !thread || session.threadId !== thread.id)
    throw new Error("runtime_session_mismatch");
  const events: DomainEvent[] = [];
  const append = (kind: EntityKind, value: Record<string, unknown>, verb = "updated") => {
    parse(entitySchemas[kind], value);
    events.push(
      parseEvent({
        eventId: `${context.commandId}:${events.length}`,
        commandId: context.commandId,
        aggregateType: kind,
        aggregateId: String(value.id ?? value.key),
        type: `${kind}.${verb}`,
        occurredAt: context.at,
        payload: value,
      }),
    );
  };
  const ignored = { events, result: { ignored: true } };
  const terminal = ["closed", "failed"].includes(String(session.state));
  if (terminal && event.t !== "turn.done") return ignored;
  if (event.t === "capabilities.updated") {
    append("session", {
      ...session,
      capabilities: event.capabilities,
      ...(event.providerVersion !== undefined ? { providerVersion: event.providerVersion } : {}),
    });
    return { events, result: { capabilitiesUpdated: true } };
  }
  if (event.t === "session.ready") {
    if (session.nativeId !== undefined && session.nativeId !== event.nativeId)
      throw new Error("runtime_native_identity_changed");
    append("session", {
      ...session,
      nativeId: event.nativeId,
      capabilities: event.capabilities,
      providerVersion: event.providerVersion,
      state: session.state === "running" ? "running" : "ready",
    });
    return { events, result: { ready: true } };
  }
  if (
    event.t === "interaction.requested" ||
    event.t === "interaction.cleared" ||
    event.t === "usage.updated"
  )
    return {
      events,
      result: { service: event.t.startsWith("interaction.") ? "interaction" : "usage" },
    };
  if (event.t === "status" || event.t === "queue.updated")
    return { events, result: { transient: true } };
  // Session scoped state: providers report these between turns as well as inside them.
  if (event.t === "mode.changed") {
    if (session.mode === event.mode) return ignored;
    append("session", { ...session, mode: event.mode });
    return { events, result: { mode: event.mode } };
  }
  if (event.t === "background.updated") {
    const tasks = Array.isArray(session.background) ? (session.background as BackgroundTask[]) : [];
    const index = tasks.findIndex((task) => task.id === event.task.id);
    const previous = tasks[index];
    if (
      previous &&
      (JSON.stringify(previous) === JSON.stringify(event.task) ||
        (previous.state !== "running" && event.task.state === "running"))
    )
      return ignored;
    const next = previous
      ? tasks.map((task, position) => (position === index ? event.task : task))
      : [...tasks, event.task];
    while (next.length > backgroundTaskLimit) {
      const finished = next.findIndex((task) => task.state !== "running");
      next.splice(finished >= 0 ? finished : 0, 1);
    }
    append("session", { ...session, background: next });
    return { events, result: { backgroundTaskId: event.task.id } };
  }
  if (event.t === "turn.started") {
    const existing = state.turn?.find((row) => row.id === event.turnId);
    if (existing) {
      if (existing.sessionId !== input.sessionId || existing.threadId !== input.threadId)
        throw new Error("runtime_turn_conflict");
      return ignored;
    }
    if (state.turn?.some((row) => row.sessionId === session.id && row.status === "running"))
      throw new Error("runtime_turn_already_running");
    append(
      "turn",
      {
        id: event.turnId,
        sessionId: session.id,
        threadId: thread.id,
        status: "running",
        origin: input.origin ?? "human",
        startedAt: context.at,
      },
      "created",
    );
    append("session", { ...session, state: "running" });
    return { events, result: { started: true, turnId: event.turnId } };
  }
  if (event.t === "compaction") {
    if (event.state === "started") return { events, result: { transient: true } };
    if (!input.itemId) throw new Error("runtime_item_id_required");
    const owner = input.turnId
      ? state.turn?.find((row) => row.id === input.turnId)
      : state.turn?.find((row) => row.sessionId === session.id && row.status === "running");
    if (owner && (owner.sessionId !== session.id || owner.threadId !== thread.id))
      throw new Error("runtime_turn_missing");
    if (input.turnId && !owner) throw new Error("runtime_turn_missing");
    const previous = state.item?.find((row) => row.id === input.itemId);
    const oldBody = previous?.body as Record<string, unknown> | undefined;
    if (
      previous &&
      (previous.threadId !== thread.id ||
        previous.kind !== "note" ||
        oldBody?.code !== "context_compacted" ||
        (previous.turnId &&
          !state.turn?.some((row) => row.id === previous.turnId && row.sessionId === session.id)))
    )
      throw new Error("runtime_item_conflict");
    const linkedTurn = previous?.turnId ?? (owner?.status === "running" ? owner.id : undefined);
    append(
      "item",
      {
        id: input.itemId,
        threadId: thread.id,
        ...(linkedTurn ? { turnId: linkedTurn } : {}),
        seq:
          previous?.seq ??
          (state.item ?? []).reduce(
            (highest, row) =>
              row.threadId === thread.id ? Math.max(highest, Number(row.seq)) : highest,
            0,
          ) + 1,
        kind: "note",
        body: {
          ...oldBody,
          code: "context_compacted",
          trigger: event.trigger,
          ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}),
          ...(event.tokensAfter !== undefined ? { tokensAfter: event.tokensAfter } : {}),
        },
        createdAt: previous?.createdAt ?? context.at,
        updatedAt: context.at,
      },
      previous ? "updated" : "created",
    );
    for (const item of state.item ?? []) {
      const body = item.body as Record<string, unknown> | undefined;
      if (
        item.kind !== "note" ||
        body?.code !== "manual_compaction" ||
        body.sessionId !== session.id ||
        !["sending", "acknowledged"].includes(String(body.state))
      )
        continue;
      const completed = settleNativeCompaction(
        applyEvents(state, events),
        String(item.id),
        String(body.attemptId),
        "completed",
        context,
      );
      for (const update of completed.events)
        events.push({ ...update, eventId: `${context.commandId}:${events.length}` });
    }
    return { events, result: { itemId: input.itemId } };
  }
  const turnId = "turnId" in event ? event.turnId : input.turnId;
  const turn = state.turn?.find((row) => row.id === turnId);
  if (!turn || turn.sessionId !== session.id || turn.threadId !== thread.id)
    throw new Error("runtime_turn_missing");
  if (turn.status !== "running") return ignored;
  if (event.t === "turn.done") {
    append("turn", {
      ...turn,
      status: event.status,
      endedAt: context.at,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      ...(event.error ? { error: event.error } : {}),
    });
    if (!terminal) append("session", { ...session, state: "ready" });
    for (const item of state.item ?? []) {
      const body = item.body as Record<string, unknown> | undefined;
      if (item.turnId === turn.id && item.kind === "tool" && body?.status === "running")
        append("item", {
          ...item,
          body: { ...body, status: "unconfirmed", partial: true },
          updatedAt: context.at,
        });
      if (
        !input.synthetic &&
        item.kind === "note" &&
        item.threadId === thread.id &&
        body?.code === "turn_interrupt" &&
        body.turnId === turn.id &&
        body.sessionId === session.id
      ) {
        append("item", {
          ...item,
          body: { ...body, state: "completed", confirmation: "native_event" },
          updatedAt: context.at,
        });
      }
      if (
        item.turnId === turn.id &&
        ["message", "thought"].includes(String(item.kind)) &&
        body?.streaming === true
      )
        append("item", {
          ...item,
          body: {
            ...body,
            streaming: false,
            partial: true,
            interrupted: event.status !== "completed",
          },
          updatedAt: context.at,
        });
    }
    const pending = (state.interaction ?? []).filter(
      (row) => row.turnId === turn.id && !input.heldInteractionIds?.includes(String(row.id)),
    );
    const expired = expireInteractions(
      { ...state, interaction: pending },
      [input.threadId],
      "turn_ended",
      context,
    );
    for (const expiredEvent of expired.events)
      events.push({ ...expiredEvent, eventId: `${context.commandId}:${events.length}` });
    return { events, result: { ended: true, turnId } };
  }
  if (event.t === "text.delta" || event.t === "thought.delta")
    return { events, result: { transient: true } };
  if (!input.itemId) throw new Error("runtime_item_id_required");
  const previous = state.item?.find((row) => row.id === input.itemId);
  if (previous && (previous.threadId !== thread.id || previous.turnId !== turn.id))
    throw new Error("runtime_item_conflict");
  const oldBody =
    previous?.body && typeof previous.body === "object" && !Array.isArray(previous.body)
      ? (previous.body as Record<string, unknown>)
      : {};
  let kind: string;
  let body: Record<string, unknown>;
  let phase: "commentary" | "final" | undefined;
  switch (event.t) {
    case "message.done":
    case "thought.done":
      kind = event.t === "message.done" ? "message" : "thought";
      body = {
        text: event.text,
        nativeItemId: event.itemId,
        ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
      };
      if (event.t === "message.done") phase = event.phase;
      break;
    case "tool.started":
      if (previous && previous.kind !== "tool") throw new Error("runtime_item_conflict");
      if (previous && oldBody.status !== "running") return ignored;
      kind = "tool";
      body = {
        ...oldBody,
        nativeItemId: event.itemId,
        name: event.name,
        kind: event.kind,
        input: event.input,
        ...(event.check ? { check: event.check } : {}),
        status: "running",
        partial: false,
        ...(event.locations ? { locations: event.locations } : {}),
        ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.interactive !== undefined ? { interactive: event.interactive } : {}),
      };
      break;
    case "tool.updated":
    case "tool.done":
      if (previous && (previous.kind !== "tool" || oldBody.nativeItemId !== event.itemId))
        throw new Error("runtime_item_conflict");
      if (previous && oldBody.status !== "running" && event.t === "tool.updated") return ignored;
      kind = "tool";
      body = {
        ...oldBody,
        nativeItemId: event.itemId,
        status: oldBody.status ?? "running",
        partial: !previous || oldBody.partial === true,
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.t === "tool.updated" && event.content ? { content: event.content } : {}),
        ...(event.t === "tool.done"
          ? { status: event.status, ...(event.diffs ? { diffs: event.diffs } : {}) }
          : {}),
      };
      break;
    case "plan.updated":
      kind = "plan";
      body = { entries: event.entries };
      break;
    default:
      return ignored;
  }
  if (previous && previous.kind !== kind) throw new Error("runtime_item_conflict");
  append(
    "item",
    {
      id: input.itemId,
      threadId: thread.id,
      turnId: turn.id,
      seq:
        previous?.seq ??
        (state.item ?? []).reduce(
          (highest, row) =>
            row.threadId === thread.id ? Math.max(highest, Number(row.seq)) : highest,
          0,
        ) + 1,
      kind,
      body,
      ...(phase ? { phase } : {}),
      createdAt: previous?.createdAt ?? context.at,
      updatedAt: context.at,
    },
    previous ? "updated" : "created",
  );
  return { events, result: { itemId: input.itemId } };
}
