import { createHash } from "node:crypto";
import { parse, parseEvent, ViewPermissionSchema, type ViewRecord } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { ViewRegistry } from "./registry.js";
export function viewGrants(store: Store, id: string) {
  return (
    store.database
      .prepare("SELECT permission FROM view_grants WHERE view_id=? ORDER BY permission")
      .all(id) as { permission: string }[]
  ).map((row) => parse(ViewPermissionSchema, row.permission));
}
export function reviewedGrants(store: Store, id: string): NonNullable<ViewRecord["reviewed"]> {
  const row = store.database
    .prepare("SELECT requested FROM view_reviews WHERE view_id=?")
    .get(id) as { requested: string } | undefined;
  return row ? JSON.parse(row.requested) : [];
}
export async function setViewGrants(
  registry: ViewRegistry,
  params: Record<string, unknown>,
  commandId: string,
) {
  if (params.confirmed !== true) throw Error("view_grant_confirmation_required");
  const id = String(params.id),
    old = registry.store.record("view", id);
  if (!old || !registry.bundle(String(old.bundleHash))) throw Error("view_not_found");
  const requested = old.requested as string[],
    permissions = params.permissions as string[];
  if (
    !Array.isArray(permissions) ||
    new Set(permissions).size !== permissions.length ||
    permissions.some((permission) => !requested.includes(permission))
  )
    throw Error("invalid_view_permissions");
  for (const permission of permissions) parse(ViewPermissionSchema, permission);
  const digest = createHash("sha256")
    .update(JSON.stringify([id, permissions]))
    .digest("hex");
  const prior = registry.store.receipt<{ digest: string }>(commandId);
  if (prior && prior.result.digest !== digest) throw Error("command_receipt_conflict");
  const guard = prior ? () => {} : await registry.checkPublic({ id, permissions });
  const at = new Date().toISOString(),
    before = registry.store.lastSeq();
  const result = registry.store.dispatch(commandId, (state) => {
    guard(state);
    registry.store.database.prepare("DELETE FROM view_grants WHERE view_id=?").run(id);
    for (const permission of permissions)
      registry.store.database
        .prepare("INSERT INTO view_grants VALUES(?,?,?)")
        .run(id, permission, at);
    registry.store.database
      .prepare(
        "INSERT INTO view_reviews VALUES(?,?) ON CONFLICT(view_id) DO UPDATE SET requested=excluded.requested",
      )
      .run(id, JSON.stringify(requested));
    const record = { ...old, granted: permissions, reviewed: requested };
    return {
      events: [
        parseEvent({
          eventId: `${commandId}:0`,
          aggregateType: "view",
          aggregateId: id,
          type: "view.updated",
          occurredAt: at,
          payload: record,
        }),
        parseEvent({
          eventId: `${commandId}:1`,
          aggregateType: "audit",
          aggregateId: `audit:${commandId}`,
          type: "audit.created",
          occurredAt: at,
          payload: {
            id: `audit:${commandId}`,
            actor: { kind: "human", id: "local-owner" },
            action: "view.setGrants",
            target: id,
            result: "allowed",
            detail: { permissions, confirmed: true },
            at,
          },
        }),
      ],
      result: { digest, record },
    };
  });
  registry.publish(registry.store.eventsSince(before));
  return result.result.record;
}
