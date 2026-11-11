import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { possibleSecret } from "@zoltbot/artifact-validation";
import type { DomainEvent, ViewRecord } from "@zoltbot/protocol";
import { parse, parseEvent, ViewRecordSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { RuntimeContext } from "../api-types.js";
import { safeFile } from "../artifacts/intake.js";
import type { Cleanup } from "../daemon-resources.js";
import type { PublicWriteCheck } from "../private-input.js";
import { callView, type ViewActions } from "./actions.js";
import { viewLoadMessage } from "./errors.js";
import { userRoot } from "./files.js";
import { reviewedGrants, setViewGrants, viewGrants } from "./grants.js";
import { installView } from "./install.js";
import { viewLifecycle } from "./lifecycle.js";
import { loadViews, type ViewBundle, viewHash, viewRecord } from "./loader.js";
import { viewStateApi } from "./state.js";
import { watchViews } from "./watch.js";

export class ViewRegistry {
  private bundles = new Map<string, ViewBundle>();
  private pending: Promise<unknown> = Promise.resolve();
  private builtins = new Map<string, ViewBundle>();
  private stopWatch: (() => void) | undefined;
  private closed = false;
  private started = false;
  constructor(
    readonly store: Store,
    readonly builtin: string,
    readonly user: string,
    readonly publish: (events: DomainEvent[]) => void,
    readonly checkPublic: (value: unknown) => Promise<PublicWriteCheck> = async () => () => {},
  ) {}
  actions?: ViewActions;
  async start(resources: Cleanup[], failed: () => void = () => {}) {
    if (this.closed) throw Error("view_registry_closed");
    if (!this.started) {
      this.started = true;
      resources.push(() => this.close());
      try {
        await userRoot(this.user);
        this.stopWatch = watchViews(this.user, () => this.reload(), failed);
      } catch {
        failed();
      }
    }
    return this.reload();
  }
  async close() {
    this.closed = true;
    this.stopWatch?.();
    this.stopWatch = undefined;
    await this.pending.catch(() => {});
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Error("view_registry_closed"));
    const next = this.pending.catch(() => {}).then(work);
    this.pending = next;
    return next;
  }
  reload(): Promise<ViewRecord[]> {
    return this.run(() => this.refresh());
  }
  builtinBundle(id: string) {
    return this.builtins.get(id);
  }
  /** Call within run(), so filesystem mutations and reloads stay in one sequence. */
  async refresh() {
    const loaded = await loadViews(this.builtin, this.user),
      records: ViewRecord[] = [];
    this.builtins = loaded.builtins;
    for (const [id, bundle] of loaded.bundles) {
      const before = this.store.record("view", id);
      const next = viewRecord(
        bundle,
        loaded.builtins.get(id),
        viewGrants(this.store, id).filter((permission) =>
          bundle.manifest.permissions.includes(permission),
        ),
        before?.removed === true || before?.enabled !== false,
        loaded.builtins.get(bundle.manifest.basedOn?.id ?? id),
      );
      next.reviewed = reviewedGrants(this.store, id);
      const error = loaded.errors.find((entry) => entry.id === id && entry.source === "user");
      if (error)
        next.error = {
          code: "view_invalid_user",
          message: viewLoadMessage(error.code),
          path: error.path,
        };
      records.push(next);
    }
    for (const error of loaded.errors) {
      if (!/^[a-z0-9-]{2,40}$/.test(error.id) || records.some((record) => record.id === error.id))
        continue;
      records.push({
        id: error.id,
        name: error.id,
        source: error.source,
        version: "0.0.0",
        api: 1,
        slots: ["page"],
        entry: "index.html",
        bundleHash: "",
        requested: [],
        granted: [],
        overridesBuiltin: false,
        enabled: false,
        error: { code: "view_invalid", message: viewLoadMessage(error.code), path: error.path },
      });
    }
    for (const old of this.store.snapshot(["view"]).view ?? [])
      if (!records.some((record) => record.id === old.id)) {
        if (old.removed === true) {
          records.push(parse(ViewRecordSchema, old));
          continue;
        }
        records.push({
          ...parse(ViewRecordSchema, old),
          enabled: false,
          granted: [],
          bundleHash: "",
          error: { code: "view_unavailable", message: "View files are unavailable." },
        });
      }
    this.bundles = loaded.bundles;
    const guards: PublicWriteCheck[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      if (JSON.stringify(record) === JSON.stringify(this.store.record("view", record.id))) continue;
      try {
        if (possibleSecret("", JSON.stringify(record))) throw Error("view_private_metadata");
        guards.push(await this.checkPublic(record));
      } catch {
        // Keep private values out of both the projection and the event log (I7).
        records[index] = {
          id: record.id,
          name: record.id,
          source: record.source,
          version: "0.0.0",
          api: 1,
          slots: ["page"],
          bundleHash: "",
          entry: "index.html",
          requested: [],
          granted: [],
          enabled: false,
          overridesBuiltin: false,
          error: {
            code: "view_private_metadata",
            message: "The manifest contains private data. Remove it and reload.",
          },
        };
        this.bundles.delete(record.id);
      }
    }
    const changed = records.filter(
      (record) => JSON.stringify(record) !== JSON.stringify(this.store.record("view", record.id)),
    );
    if (changed.length) {
      const commandId = `view-reload:${randomUUID()}`,
        before = this.store.lastSeq(),
        at = new Date().toISOString();
      this.store.dispatch(commandId, (state) => {
        for (const guard of guards) guard(state);
        return {
          events: changed.map((record, index) =>
            parseEvent({
              eventId: `${commandId}:${index}`,
              aggregateType: "view",
              aggregateId: record.id,
              type: "view.updated",
              occurredAt: at,
              payload: record,
            }),
          ),
          result: { ok: true },
        };
      });
      this.publish(this.store.eventsSince(before));
    }
    return records;
  }
  async api(method: string, params: Record<string, unknown>, commandId?: string) {
    if (this.closed) throw Error("view_registry_closed");
    if (method === "view.reload") return this.reload();
    if (method === "view.import" || method === "view.remove") {
      if (!commandId) throw Error("command_id_required");
      return this.run(() => installView(this, method, params, commandId));
    }
    if (method === "view.customize" || method === "view.resolveUpdate") {
      if (!commandId) throw Error("command_id_required");
      return this.run(() => viewLifecycle(this, method, params, commandId));
    }
    if (method === "view.state.get" || method === "view.state.set")
      return viewStateApi(this, method, params);
    if (method === "view.call") {
      if (!commandId) throw Error("command_id_required");
      if (!this.actions) throw Error("unavailable");
      return callView(this, this.actions, params, commandId);
    }
    if (method === "view.setGrants") {
      if (!commandId) throw Error("command_id_required");
      return setViewGrants(this, params, commandId);
    }
    if (method !== "view.setEnabled") return undefined;
    if (!commandId) throw Error("command_id_required");
    const old = this.store.record("view", String(params.id));
    if (!old) throw Error("view_not_found");
    const record = { ...old, enabled: params.enabled };
    const before = this.store.lastSeq();
    const receipt = this.store.dispatch(commandId, () => ({
      events: [
        parseEvent({
          eventId: `${commandId}:0`,
          aggregateType: "view",
          aggregateId: String(old.id),
          type: "view.updated",
          occurredAt: new Date().toISOString(),
          payload: record,
        }),
      ],
      result: record,
    }));
    this.publish(this.store.eventsSince(before));
    return receipt.result;
  }
  bundle(hash: string) {
    return [...this.bundles.values()].find((bundle) => bundle.bundleHash === hash);
  }
  async asset(hash: string, fileHash?: string) {
    const bundle = this.bundle(hash);
    if (!bundle) throw Error("view_bundle_not_found");
    if (!fileHash)
      return {
        bytes: Buffer.from(
          JSON.stringify({ manifestBytes: bundle.manifestBytes, files: bundle.files }),
        ),
        mime: "application/json",
      };
    const file = bundle.files.find((entry) => entry.hash === fileHash);
    if (!file) throw Error("view_file_not_found");
    const bytes = await safeFile(bundle.directory, file.path, {
      allowRootOwned: bundle.allowRootOwned,
    });
    if (bytes.length !== file.bytes || viewHash(bytes) !== file.hash)
      throw Error("view_file_changed");
    return { bytes, mime: file.mime };
  }
}

export function createViewRegistry(
  context: RuntimeContext,
  dataDir: string,
  actions?: ViewActions,
) {
  const registry = new ViewRegistry(
    context.store,
    fileURLToPath(new URL("../../../views/", import.meta.url)),
    path.join(dataDir, "views"),
    context.publish,
    (value) => context.privacy.prepareData(value),
  );
  if (actions) registry.actions = actions;
  return registry;
}
