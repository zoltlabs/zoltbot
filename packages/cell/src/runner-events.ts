import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import {
  applyEvents,
  type CommandContext,
  claimQueuedInput,
  expireInteractions,
  finishTaskTurn,
  handle,
  linkQueuedInputTurn,
  type Outcome,
  observeRuntimeEvent,
  recordUsage,
  requestInteraction,
  reserveRuntimeItem,
} from "@zoltbot/core";
import { type AgentEvent, type DomainEvent, parse, TaskSchema } from "@zoltbot/protocol";
import { RunnerEventSchema } from "@zoltbot/runner-protocol";
import type { Snapshot, Store } from "@zoltbot/store/portable";
import { CellLeases } from "./leases.js";
import { CellMacRecords } from "./mac-records.js";

const kinds = ["task", "thread", "session", "turn", "interaction", "usage", "rule"] as const;
function itemsForEvent(
  store: Store,
  state: Snapshot,
  threadId: string,
  itemId: string | undefined,
  event: AgentEvent,
) {
  const items: Record<string, unknown>[] = [];
  const add = (id: unknown) => {
    if (typeof id !== "string" || items.some((row) => row.id === id)) return;
    const row = store.record("item", id);
    if (row) items.push(row);
  };
  if (itemId) {
    const previous = store.record("item", itemId);
    const expected = event.t.startsWith("tool.")
      ? "tool"
      : event.t === "compaction"
        ? "note"
        : event.t.startsWith("thought.")
          ? "thought"
          : event.t === "plan.updated"
            ? "plan"
            : "message";
    if (previous && previous.kind !== expected) throw new Error("forbidden");
  }
  add(itemId);
  const last = store.database
    .prepare(
      "SELECT id,seq,kind,turn_id FROM item_records WHERE thread_id=? ORDER BY seq DESC LIMIT 1",
    )
    .get(threadId) as { id: string; seq: number; kind: string; turn_id: string | null } | undefined;
  if (event.t === "turn.started") {
    const queued = store.database
      .prepare(
        "SELECT id FROM items WHERE thread_id=? AND kind='user' AND json_extract(body,'$.queueState')='queued' ORDER BY seq LIMIT 1",
      )
      .get(threadId) as { id: string } | undefined;
    add(queued?.id);
  }
  if (event.t === "turn.done") {
    const rows = store.database
      .prepare(
        "SELECT id FROM items WHERE thread_id=? AND turn_id=? AND (json_extract(body,'$.status')='running' OR json_extract(body,'$.streaming')=1 OR json_extract(body,'$.code')='turn_interrupt')",
      )
      .all(threadId, event.turnId) as { id: string }[];
    for (const row of rows) add(row.id);
  }
  if (last && !items.some((row) => row.id === last.id))
    items.push({
      id: last.id,
      threadId,
      seq: last.seq,
      kind: last.kind,
      ...(last.turn_id ? { turnId: last.turn_id } : {}),
      body: {},
    });
  state.item = items;
}
/** A runner may submit normalized runtime observations only for its fenced task. */
export function runnerEvent(store: Store, claims: CellTokenClaims, runnerId: string, raw: unknown) {
  const input = parse(RunnerEventSchema, raw);
  if (!input.sessionId) throw new Error("runner_session_required");
  const sessionId = input.sessionId;
  const leases = new CellLeases(store);
  const lease = leases.require(input.taskId, input.leaseId, runnerId, claims);
  const commandId = `runner:${input.taskId}:${input.runnerSeq}`;
  if (input.runnerSeq <= lease.lastSeq) {
    if (!store.receipt(commandId)) throw new Error("runner_sequence_gap");
    return { taskId: input.taskId, runnerSeq: lease.lastSeq };
  }
  if (input.runnerSeq !== lease.lastSeq + 1) throw new Error("runner_sequence_gap");
  const task = parse(TaskSchema, store.record("task", input.taskId));
  if (!task.threadId || task.createdBy.id !== claims.sub) throw new Error("forbidden");
  const threadId = task.threadId;
  const owner = store.record("agent", String(task.ownerAgentId));
  if (!owner) throw new Error("forbidden");
  const event = input.event;
  const mac = new CellMacRecords(store, { orgId: claims.org, userId: claims.sub });
  const context: CommandContext = {
    commandId,
    at: new Date().toISOString(),
    actor: { kind: "system", id: "runner" },
  };
  return store.dispatch(
    commandId,
    (initial) => {
      let state = initial;
      itemsForEvent(store, state, threadId, input.itemId, event);
      const events: DomainEvent[] = [];
      let ended = false;
      const append = (output: Outcome) => {
        for (const update of output.events)
          events.push({ ...update, eventId: `${commandId}:${events.length}` });
        state = applyEvents(state, output.events);
      };
      if (!state.session?.some((row) => row.id === sessionId)) {
        const sessions = (state.session ?? [])
          .filter((row) => row.threadId === threadId)
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
        const previous = sessions[0];
        if (
          previous?.nativeId &&
          (event.t !== "session.ready" || event.nativeId !== previous.nativeId)
        )
          throw new Error("runtime_native_identity_changed");
        for (const old of sessions.filter((row) =>
          ["starting", "ready", "running"].includes(String(row.state)),
        )) {
          append(
            handle(
              state,
              { type: "transition", kind: "session", id: String(old.id), to: "closed" },
              context,
            ),
          );
          for (const turn of state.turn ?? [])
            if (turn.sessionId === old.id && turn.status === "running")
              append(
                handle(
                  state,
                  { type: "transition", kind: "turn", id: String(turn.id), to: "interrupted" },
                  context,
                ),
              );
        }
        append(
          handle(
            state,
            {
              type: "create",
              kind: "session",
              value: {
                id: sessionId,
                threadId,
                provider: owner.definitionId,
                cwd: ".",
                state: "starting",
                capabilities: {},
                startedAt: context.at,
                generation: Number(previous?.generation ?? 0) + 1,
              },
            },
            context,
          ),
        );
      }
      const runtime = {
        sessionId,
        threadId,
        event,
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(event.t === "turn.done" && event.status !== "completed"
          ? {
              heldInteractionIds: (state.interaction ?? [])
                .filter((row) => mac.has(String(row.id)))
                .map((row) => String(row.id)),
            }
          : {}),
      };
      const queued =
        event.t === "turn.started"
          ? state.item?.find(
              (row) =>
                row.kind === "user" &&
                (row.body as { queueState?: string })?.queueState === "queued",
            )
          : undefined;
      const attemptId = `${commandId}:input`;
      if (queued) append(claimQueuedInput(state, String(queued.id), sessionId, attemptId, context));
      if (event.t === "interaction.requested") {
        if (
          event.interaction.threadId !== threadId ||
          event.interaction.agentId !== task.ownerAgentId ||
          (event.interaction.taskId && event.interaction.taskId !== task.id)
        )
          throw new Error("forbidden");
        append(
          requestInteraction(
            state,
            { ...event.interaction, taskId: task.id },
            `${commandId}:interaction`,
            context,
          ),
        );
      } else if (event.t === "interaction.cleared") {
        const selected = (state.interaction ?? []).filter(
          (row) =>
            !mac.has(String(row.id)) &&
            row.nativeRef === event.nativeRef &&
            (!row.turnId ||
              state.turn?.some((turn) => turn.id === row.turnId && turn.sessionId === sessionId)),
        );
        append(
          expireInteractions(
            { ...state, interaction: selected },
            [threadId],
            event.reason === "provider_resolved" ? "provider_cleared" : event.reason,
            context,
            sessionId,
          ),
        );
      } else if (event.t === "usage.updated") {
        const turnId = event.turnId ?? input.turnId;
        if (!turnId) throw new Error("runtime_turn_missing");
        append(recordUsage(state, { sessionId, turnId, sample: event.usage }, context));
      } else {
        const observation =
          event.t === "text.delta" || event.t === "thought.delta"
            ? reserveRuntimeItem(state, runtime, context)
            : observeRuntimeEvent(state, runtime, context);
        ended = observation.result.ended === true;
        append(observation);
        if (queued && event.t === "turn.started")
          append(linkQueuedInputTurn(state, String(queued.id), attemptId, event.turnId, context));
      }
      if (event.t === "turn.done" && ended) {
        const rows = store.database
          .prepare(
            "SELECT id FROM items WHERE thread_id=? AND turn_id=? AND kind='message' ORDER BY seq DESC LIMIT 1",
          )
          .get(threadId, event.turnId) as { id: string } | undefined;
        const body = rows
          ? (store.record("item", rows.id)?.body as { text?: string } | undefined)
          : undefined;
        append(
          finishTaskTurn(
            state,
            task.id,
            task.revision,
            { status: event.status, text: body?.text ?? "" },
            context,
          ),
        );
      }
      leases.acknowledge(lease, input.runnerSeq);
      return { events, result: { taskId: task.id, runnerSeq: input.runnerSeq } };
    },
    { scope: { taskId: task.id }, kinds },
  ).result;
}
