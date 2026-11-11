import path from "node:path";
import { parse, parseEvent, type ViewRecord, ViewRecordSchema } from "@zoltbot/protocol";
import { copyView, deleteUserView, exists, renameUserView, updateViewManifest } from "./files.js";
import { loadView, viewHash } from "./loader.js";
import { viewOrigin, viewOriginEvent } from "./origin.js";
import type { ViewRegistry } from "./registry.js";
import { readViewState, stateDirectory, writeViewState } from "./state.js";

export async function viewLifecycle(
  registry: ViewRegistry,
  method: string,
  params: Record<string, unknown>,
  commandId: string,
) {
  const digest = viewHash(JSON.stringify([method, params]));
  const replay = registry.store.receipt<{ digest: string; record: ViewRecord }>(commandId);
  if (replay) {
    if (replay.result.digest !== digest) throw Error("command_receipt_conflict");
    return replay.result.record;
  }
  const incomplete = registry.store.receipt<{ digest: string }>(`${commandId}:confirmed`);
  if (incomplete)
    throw Error(
      incomplete.result.digest === digest
        ? "view_operation_incomplete"
        : "command_receipt_conflict",
    );
  const id = String(params.id);
  const old = registry.store.record("view", id);
  if (!old) throw Error("view_not_found");
  const current = registry.bundle(String(old.bundleHash));
  const builtin = registry.builtinBundle(
    method === "view.customize"
      ? id
      : String((old.basedOn as { id: string } | undefined)?.id ?? id),
  );
  if (!builtin) throw Error("view_builtin_not_found");
  const base = {
    id: builtin.manifest.id,
    version: builtin.manifest.version,
    bundleHash: builtin.bundleHash,
  };
  let targetId = id;
  const guard = await registry.checkPublic({ id, method, choice: params.choice ?? null });
  if (method === "view.customize") {
    if (old.source !== "builtin" || !current) throw Error("view_already_customized");
    await copyView(builtin, registry.user, { ...JSON.parse(builtin.manifestBytes), basedOn: base });
  } else {
    if (old.source !== "user" || !current || !old.basedOn || !old.builtinUpdate)
      throw Error("view_no_update");
    const fresh = await loadView(current.directory);
    if (fresh.bundleHash !== current.bundleHash) throw Error("view_changed");
    if (params.choice === "keep") {
      await updateViewManifest(current, { ...JSON.parse(current.manifestBytes), basedOn: base });
    } else if (params.choice === "replace") {
      if (params.confirmed !== true) throw Error("view_remove_confirmation_required");
      const before = registry.store.lastSeq();
      registry.store.dispatch(`${commandId}:confirmed`, (state) => {
        guard(state);
        return {
          events: [
            audit(commandId, method, id, {
              confirmed: true,
              choice: "replace",
              bundleHash: current.bundleHash,
            }),
          ],
          result: { digest },
        };
      });
      registry.publish(registry.store.eventsSince(before));
      await deleteUserView(registry.user, id, current.bundleHash);
    } else if (params.choice === "copy") {
      const stem = `${id.slice(0, 33)}-custom`;
      targetId = stem;
      for (
        let index = 2;
        registry.store.record("view", targetId) ||
        (await exists(path.join(registry.user, targetId))) ||
        (await exists(path.join(stateDirectory(registry), `${targetId}.json`)));
        index++
      ) {
        if (index > 1000) throw Error("view_name_conflict");
        const suffix = `-custom-${index}`;
        targetId = id.slice(0, 40 - suffix.length) + suffix;
      }
      const state = path.join(stateDirectory(registry), `${id}.json`);
      if (await exists(state))
        await writeViewState(registry, targetId, await readViewState(registry, id));
      await renameUserView(current, registry.user, targetId, {
        ...JSON.parse(current.manifestBytes),
        id: targetId,
        basedOn: base,
      });
    } else throw Error("invalid_view_update_choice");
  }
  const records = await registry.refresh();
  const record = records.find((row) => row.id === targetId);
  if (!record) throw Error("view_not_found");
  const before = registry.store.lastSeq();
  const result = registry.store.dispatch(commandId, (state) => {
    guard(state);
    return {
      events: [
        ...(method === "view.customize" || params.choice === "replace"
          ? [viewOriginEvent(commandId, id, null)]
          : []),
        ...(params.choice === "copy"
          ? [
              viewOriginEvent(commandId, targetId, viewOrigin(registry.store, id) ?? null),
              viewOriginEvent(commandId, id, null),
            ]
          : []),
        ...(params.choice === "replace"
          ? []
          : [audit(commandId, method, id, { choice: params.choice ?? null, targetId })]),
      ],
      result: { digest, record: parse(ViewRecordSchema, record) },
    };
  });
  registry.publish(registry.store.eventsSince(before));
  return result.result.record;
}
export function audit(
  commandId: string,
  action: string,
  target: string,
  detail: Record<string, unknown>,
) {
  const at = new Date().toISOString();
  return parseEvent({
    eventId: `${commandId}:audit`,
    aggregateType: "audit",
    aggregateId: `audit:${commandId}`,
    type: "audit.created",
    occurredAt: at,
    payload: {
      id: `audit:${commandId}`,
      actor: { kind: "human", id: "local-owner" },
      action,
      target,
      result: "allowed",
      detail,
      at,
    },
  });
}
