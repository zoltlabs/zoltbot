import path from "node:path";
import { parse, parseEvent, type ViewRecord, ViewRecordSchema } from "@zoltbot/protocol";
import { importFailure } from "./errors.js";
import { copyView, deleteUserView, exists } from "./files.js";
import { audit } from "./lifecycle.js";
import { loadView, viewHash } from "./loader.js";
import type { ViewRegistry } from "./registry.js";

export async function installView(
  registry: ViewRegistry,
  method: string,
  params: Record<string, unknown>,
  commandId: string,
) {
  if (params.confirmed !== true) throw Error("view_install_confirmation_required");
  const digest = viewHash(JSON.stringify([method, params]));
  const replay = registry.store.receipt<{ digest: string; record: ViewRecord }>(commandId);
  if (replay) {
    if (replay.result.digest !== digest) throw Error("command_receipt_conflict");
    return replay.result.record;
  }
  const source =
    method === "view.import"
      ? await loadView(path.resolve(String(params.path))).catch((error) => {
          throw Error(importFailure(error));
        })
      : undefined;
  const incomplete = registry.store.receipt<{ digest: string }>(`${commandId}:confirmed`);
  if (incomplete)
    throw Error(
      incomplete.result.digest === digest
        ? "view_operation_incomplete"
        : "command_receipt_conflict",
    );
  const id = source?.manifest.id ?? String(params.id);
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw Error("invalid_view_id");
  const old = registry.store.record("view", id),
    folder = path.join(registry.user, id),
    present = await exists(folder);
  if (source && present) throw Error("view_folder_exists");
  if (!source && (!old || old.removed || (!present && old.source !== "user")))
    throw Error("view_not_found");
  const guard = await registry.checkPublic({ method, id });
  const standalone = !registry.builtinBundle(id);
  const before = registry.store.lastSeq();
  registry.store.dispatch(`${commandId}:confirmed`, (state) => {
    guard(state);
    const clear = !!source || standalone;
    if (clear) {
      registry.store.database.prepare("DELETE FROM view_grants WHERE view_id=?").run(id);
      registry.store.database.prepare("DELETE FROM view_reviews WHERE view_id=?").run(id);
    }
    return {
      events: [
        audit(commandId, method, id, {
          confirmed: true,
          ...(source ? { bundleHash: source.bundleHash } : {}),
        }),
        ...(clear && old
          ? [
              parseEvent({
                eventId: `${commandId}:grants`,
                aggregateType: "view",
                aggregateId: id,
                type: "view.updated",
                occurredAt: new Date().toISOString(),
                payload: {
                  ...old,
                  granted: [],
                  reviewed: [],
                  ...(source ? { enabled: true, removed: false } : {}),
                },
              }),
            ]
          : []),
      ],
      result: { digest },
    };
  });
  registry.publish(registry.store.eventsSince(before));
  if (source) {
    const manifest = JSON.parse(source.manifestBytes);
    delete manifest.basedOn;
    await copyView(source, registry.user, manifest);
  } else if (present) {
    const expected = old?.source === "user" && old.bundleHash ? String(old.bundleHash) : undefined;
    await deleteUserView(registry.user, id, expected);
  }
  if (!source && standalone && old) {
    const beforeRemove = registry.store.lastSeq();
    registry.store.dispatch(`${commandId}:removed`, () => ({
      events: [
        parseEvent({
          eventId: `${commandId}:removed`,
          aggregateType: "view",
          aggregateId: id,
          type: "view.updated",
          occurredAt: new Date().toISOString(),
          payload: {
            ...old,
            removed: true,
            enabled: false,
            granted: [],
            reviewed: [],
            bundleHash: "",
          },
        }),
      ],
      result: {},
    }));
    registry.publish(registry.store.eventsSince(beforeRemove));
  }
  const records = await registry.refresh(),
    record = records.find((row) => row.id === id);
  if (!record) throw Error("view_not_found");
  return registry.store.dispatch(commandId, () => ({
    events: [],
    result: { digest, record: parse(ViewRecordSchema, record) },
  })).result.record;
}
