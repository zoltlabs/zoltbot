// I1: bridge rows in the settings table. Only the daemon writes them (settings.set refuses the
// `bridge.` prefix), and a removed row is written as false because settings rows aren't deleted.
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { ReplyTarget } from "@zoltbot/bridges";
import {
  type Bridge,
  type BridgeRefusal,
  BridgeRefusalSchema,
  BridgeSchema,
  type BridgeStatus,
  BridgeStatusSchema,
  type BridgeView,
  bridgeKey,
  bridgePendingKey,
  bridgeRefusedKey,
  bridgeRow,
  bridgeStatusKey,
  type DomainEvent,
  MAX_BRIDGE_REFUSALS,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

/** A bridged message waiting for its answer. */
export interface PendingReply {
  /** The app's message id. */
  id: string;
  routeId: string;
  reply: ReplyTarget;
  at: string;
  /** Chat targets: the queued input, then the turn that answers it. */
  itemId?: string;
  turnId?: string;
  /** Channel targets: the request the post started. */
  requestId?: string;
}
export const MAX_PENDING = 100;
/** A channel request can keep answering for a while; a chat turn normally ends sooner. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

export function bridgeRows(store: Store) {
  const rows = (store.snapshot(["settings"]).settings ?? []) as Row[];
  const bridges = new Map<string, Bridge>();
  const status = new Map<string, BridgeStatus>();
  const refused = new Map<string, BridgeRefusal[]>();
  const pending = new Map<string, PendingReply[]>();
  for (const row of rows) {
    const where = bridgeRow(row.key);
    if (!where || !row.value) continue;
    if (where.row === "record" && Value.Check(BridgeSchema, row.value))
      bridges.set(where.id, row.value);
    if (where.row === "status" && Value.Check(BridgeStatusSchema, row.value))
      status.set(where.id, row.value);
    if (where.row === "refused" && Array.isArray(row.value))
      refused.set(
        where.id,
        row.value.filter((entry) => Value.Check(BridgeRefusalSchema, entry)) as BridgeRefusal[],
      );
    if (where.row === "pending" && Array.isArray(row.value))
      pending.set(where.id, row.value.filter(isPending));
  }
  return { bridges, status, refused, pending };
}

function isPending(value: unknown): value is PendingReply {
  const entry = value as Partial<PendingReply> | null;
  return (
    typeof entry?.id === "string" &&
    typeof entry.routeId === "string" &&
    typeof entry.at === "string" &&
    !!entry.reply &&
    typeof entry.reply === "object"
  );
}

const STOPPED: BridgeStatus = { state: "stopped", at: new Date(0).toISOString() };

export function bridgeView(store: Store, id: string): BridgeView | undefined {
  const rows = bridgeRows(store);
  const bridge = rows.bridges.get(id);
  if (!bridge) return undefined;
  return {
    bridge,
    status: rows.status.get(id) ?? STOPPED,
    refused: (rows.refused.get(id) ?? []).slice(0, MAX_BRIDGE_REFUSALS),
  };
}

export function bridgeViews(store: Store): BridgeView[] {
  const rows = bridgeRows(store);
  return [...rows.bridges.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((bridge) => ({
      bridge,
      status: rows.status.get(bridge.id) ?? STOPPED,
      refused: (rows.refused.get(bridge.id) ?? []).slice(0, MAX_BRIDGE_REFUSALS),
    }));
}

/** Writes settings rows in one store command and publishes them. */
export function writeRows(
  store: Store,
  publish: (events: DomainEvent[]) => void,
  entries: { key: string; value: unknown }[],
  commandId = `bridge:${randomUUID()}`,
) {
  if (!entries.length) return;
  const before = store.lastSeq();
  const at = new Date().toISOString();
  store.dispatch(commandId, () => ({
    events: entries.map((entry, index) => ({
      eventId: `${commandId}:${index}`,
      aggregateType: "settings",
      aggregateId: entry.key,
      type: "settings.created",
      occurredAt: at,
      payload: { key: entry.key, value: entry.value },
    })),
    result: { ok: true },
  }));
  publish(store.eventsSince(before));
}

export const rowKeys = {
  record: bridgeKey,
  status: bridgeStatusKey,
  refused: bridgeRefusedKey,
  pending: bridgePendingKey,
};
