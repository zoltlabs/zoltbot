import { existsSync } from "node:fs";
import { applyEvents, type DomainState } from "@zoltbot/core/projectors";
import {
  type DomainEvent,
  HOST_WORKSPACE_REF,
  NativeCompactionBodySchema,
  parse,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export function recover(store: Store, bootId: string, at = new Date().toISOString()) {
  const events: DomainEvent[] = [];
  let state: DomainState = store.snapshot();
  let index = 0;
  const append = (kind: string, record: Record<string, unknown>, type = `${kind}.updated`) => {
    const e: DomainEvent = {
      eventId: `${bootId}:${index++}`,
      commandId: bootId,
      aggregateType: kind,
      aggregateId: String(record.id),
      type,
      occurredAt: at,
      payload: record,
    };
    events.push(e);
    state = applyEvents(state, [e]);
  };
  for (const t of state.turn ?? [])
    if (t.status === "running")
      append("turn", { ...t, status: "interrupted", endedAt: at, stopReason: "daemon_restart" });
  for (const item of state.item ?? []) {
    const body = item.body;
    if (
      item.kind === "tool" &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).status === "running"
    ) {
      append("item", {
        ...item,
        body: { ...body, status: "unconfirmed", partial: true },
        updatedAt: at,
      });
      continue;
    }
    if (
      ["message", "thought"].includes(String(item.kind)) &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).streaming === true
    ) {
      append("item", {
        ...item,
        body: {
          ...(body as Record<string, unknown>),
          streaming: false,
          partial: true,
          interrupted: true,
        },
        updatedAt: at,
      });
      continue;
    }
    if (item.kind === "note" && body && typeof body === "object" && !Array.isArray(body)) {
      const operation = body as Record<string, unknown>;
      if (
        operation.code === "turn_interrupt" &&
        ["requested", "acknowledged"].includes(String(operation.state))
      ) {
        append("item", {
          ...item,
          body: {
            ...operation,
            state: "uncertain",
            text: "Stopping was not confirmed before Zoltbot restarted. Review the native session before continuing.",
          },
          updatedAt: at,
        });
        continue;
      }
      if (
        operation.code === "manual_compaction" &&
        operation.operationVersion === 1 &&
        ["sending", "acknowledged"].includes(String(operation.state))
      ) {
        const held = parse(NativeCompactionBodySchema, {
          ...operation,
          state: "uncertain",
          errorCode: "delivery_uncertain",
        });
        append("item", { ...item, body: held, updatedAt: at });
        continue;
      }
    }
    if (item.kind !== "user" || !body || typeof body !== "object" || Array.isArray(body)) continue;
    const queued = body as Record<string, unknown>;
    if (queued.queueVersion !== 1 || queued.queueState !== "sending") continue;
    append("item", {
      ...item,
      body: { ...queued, queueState: "uncertain", errorCode: "delivery_uncertain" },
      updatedAt: at,
    });
    const seq =
      (state.item ?? []).reduce(
        (highest, row) =>
          row.threadId === item.threadId ? Math.max(highest, Number(row.seq)) : highest,
        0,
      ) + 1;
    append(
      "item",
      {
        id: `input-recovery:${item.id}:${bootId}`,
        threadId: item.threadId,
        seq,
        kind: "note",
        body: {
          code: "input_delivery_uncertain",
          inputId: item.id,
          text: "Delivery may have started before Zoltbot stopped. Review the native session before retrying.",
        },
        createdAt: at,
        updatedAt: at,
      },
      "item.created",
    );
  }
  for (const i of state.interaction ?? [])
    if (i.state === "pending" && i.nativeRef !== HOST_WORKSPACE_REF) {
      append(
        "interaction",
        { ...i, state: "expired", version: Number(i.version) + 1, resolvedAt: at },
        "interaction.expired",
      );
      const seq =
        Math.max(
          0,
          ...(state.item ?? [])
            .filter((row) => row.threadId === i.threadId)
            .map((row) => Number(row.seq)),
        ) + 1;
      append(
        "item",
        {
          id: `recovery-note:${i.id}:${bootId}`,
          threadId: i.threadId,
          seq,
          kind: "note",
          body: {
            text: "This request expired after the daemon restarted. You can send your answer as a message.",
            interactionId: i.id,
          },
          createdAt: at,
          updatedAt: at,
        },
        "item.created",
      );
    }
  for (const s of state.session ?? [])
    if (["starting", "ready", "running"].includes(String(s.state)))
      append("session", { ...s, state: "closed", endedAt: at, endReason: "daemon_restart" });
  for (const d of state.delivery ?? [])
    if (d.state === "delivering") {
      const completed = (state.turn ?? []).some(
        (t) => t.id === d.turnId && t.status === "completed",
      );
      append("delivery", {
        ...d,
        state: completed ? "delivered" : "queued",
        ...(completed ? { deliveredAt: at } : {}),
      });
    }
  for (const t of state.task ?? [])
    if (t.state === "running") {
      const workspace = (state.workspace ?? []).find((w) => w.id === t.workspaceId);
      const missing = Boolean(t.workspaceId) && (!workspace || !existsSync(String(workspace.path)));
      append("task", {
        ...t,
        state: missing ? "failed" : "blocked",
        holdReason: missing
          ? "workspace_missing"
          : state.routineOccurrence?.some(
                (row) =>
                  row.taskId === t.id && row.permissionDeadline && row.outcome === "needs_you",
              )
            ? "routine_needs_you"
            : "daemon_restarted",
        updatedAt: at,
      });
    }
  // Construct recovery as one receipt so a partial boot cannot expire requests twice.
  if (events.length)
    store.dispatch(bootId, () => ({ events, result: { recovered: events.length } }));
  return events.length;
}
