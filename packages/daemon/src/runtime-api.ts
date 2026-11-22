import { randomUUID } from "node:crypto";
import type { ModelList } from "@zoltbot/adapters-sdk";
import {
  cancelQueuedInput,
  type DomainState,
  queueHumanInput,
  reorderQueuedInput,
  requestSessionConnect,
  sendQueuedInputNow,
} from "@zoltbot/core";
import {
  ArtifactTargetSchema,
  type DomainEvent,
  OutputModeSchema,
  parse,
  QueuedInputBodySchema,
  UserInputSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { prepareRevisionTarget, revisionTarget } from "./artifacts/revision-target.js";
import { modelCatalog } from "./model-catalog.js";
import { sessionCommands } from "./session-commands.js";
import type { SessionManager } from "./session-manager.js";

const sessionControls = new Set([
  "session.setMode",
  "session.setModel",
  "session.setEffort",
  "session.setServiceTier",
  "session.stopBackground",
  "session.rewind",
]);

export function runtimeApi(options: {
  store: Store;
  manager?: SessionManager;
  publish(events: DomainEvent[]): void;
  /** Asks a definition's provider for its models without opening a session. */
  listModels?(definitionId: string): Promise<ModelList>;
  onError?(code: string): void;
}) {
  let controls: ReturnType<typeof sessionCommands> | undefined;
  // What model.refresh last listed per definition, for definitions no session has reported yet.
  const listed = new Map<string, ModelList>();
  const listing = new Map<string, Promise<boolean>>();
  const refresh = (definitionId: string) => {
    const listModels = options.listModels;
    if (!listModels) return Promise.resolve(false);
    let work = listing.get(definitionId);
    if (!work) {
      work = listModels(definitionId)
        .then((models) => {
          listed.set(definitionId, models);
          return true;
        })
        .catch((error: unknown) => {
          const code = error instanceof Error ? error.message : "model_list_failed";
          if (code !== "model_list_unavailable") options.onError?.(`model_refresh_failed:${code}`);
          return false;
        })
        .finally(() => listing.delete(definitionId));
      listing.set(definitionId, work);
    }
    return work;
  };
  return (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
    check?: (state: DomainState) => void,
  ): unknown => {
    if (method === "turn.cancelQueued") {
      if (!commandId) throw new Error("command_id_required");
      const threadId = String(params.threadId),
        id = String(params.id),
        before = options.store.lastSeq();
      let produced = false;
      const receipt = options.store.dispatch(commandId, (state) => {
        produced = true;
        return cancelQueuedInput(state, threadId, id, {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "human", id: "local-owner" },
        });
      });
      if (
        receipt.result.kind !== "cancel_input" ||
        receipt.result.id !== id ||
        receipt.result.threadId !== threadId
      )
        throw new Error("command_receipt_conflict");
      if (produced) options.publish(options.store.eventsSince(before));
      return { ok: true };
    }
    if (method === "turn.reorderQueued" || method === "turn.sendQueuedNow") {
      if (!commandId) throw new Error("command_id_required");
      const threadId = String(params.threadId),
        before = options.store.lastSeq();
      const context = {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "human" as const, id: "local-owner" },
      };
      let produced = false;
      const receipt = options.store.dispatch(commandId, (state) => {
        produced = true;
        if (method === "turn.sendQueuedNow")
          return sendQueuedInputNow(state, threadId, String(params.id), context);
        if (!Array.isArray(params.order)) throw new Error("queue_changed");
        return reorderQueuedInput(state, threadId, params.order.map(String), context);
      });
      const kind = method === "turn.sendQueuedNow" ? "queue_send_now" : "queue_order";
      const same =
        method === "turn.sendQueuedNow"
          ? receipt.result.id === params.id
          : JSON.stringify(receipt.result.order) === JSON.stringify(params.order);
      if (receipt.result.kind !== kind || receipt.result.threadId !== threadId || !same)
        throw new Error("command_receipt_conflict");
      if (produced) options.publish(options.store.eventsSince(before));
      // Send now may let the worker steer or start the message at once; a reorder never does.
      if (produced && method === "turn.sendQueuedNow")
        void options.manager
          ?.ensure(threadId)
          .then((worker) => worker.wake())
          .catch(() => options.onError?.("runtime_open_failed"));
      return method === "turn.sendQueuedNow"
        ? { ok: true, delivery: receipt.result.delivery }
        : { ok: true };
    }
    if (method === "model.catalog") return modelCatalog(options.store.snapshot(), listed);
    if (method === "model.refresh") {
      const ids =
        typeof params.definitionId === "string"
          ? [params.definitionId]
          : (options.store.snapshot(["agentDefinition"]).agentDefinition ?? [])
              .filter((row) => row.archived !== true)
              .map((row) => String(row.id));
      return Promise.all(ids.map(refresh)).then((results) => ({
        ok: results.length > 0 && results.every(Boolean),
      }));
    }
    const manager = options.manager;
    if (method === "session.context")
      return (manager?.contextUsage(String(params.threadId)) ?? Promise.resolve(null)).then(
        (usage) => usage ?? {},
      );
    // The Mac serves these; it just has no agents running to apply them to.
    if (!manager && sessionControls.has(method)) throw new Error("runtime_unavailable");
    if (!manager) return undefined;
    controls ??= sessionCommands({ store: options.store, manager, publish: options.publish });
    const control = controls(method, params, commandId);
    if (control) return control;
    if (method === "session.connect") {
      if (!commandId) throw new Error("command_id_required");
      const threadId = String(params.threadId),
        previousSessionId =
          typeof params.previousSessionId === "string" ? params.previousSessionId : undefined,
        before = options.store.lastSeq();
      let produced = false;
      const receipt = options.store.dispatch(commandId, (state) => {
        produced = true;
        return requestSessionConnect(state, threadId, previousSessionId, {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "human", id: "local-owner" },
        });
      });
      if (
        receipt.result.kind !== "session_connect" ||
        receipt.result.threadId !== threadId ||
        receipt.result.previousSessionId !== (previousSessionId ?? null)
      )
        throw new Error("command_receipt_conflict");
      if (!produced) return { ok: true };
      options.publish(options.store.eventsSince(before));
      return manager.ensure(threadId).then((worker) => {
        worker.wake();
        return { ok: true };
      });
    }
    if (method === "turn.interrupt") {
      if (!commandId) throw new Error("command_id_required");
      return manager.interrupt(String(params.threadId), String(params.turnId), commandId);
    }
    if (method === "session.compact") {
      if (!commandId) throw new Error("command_id_required");
      return manager.compact(
        String(params.id),
        typeof params.instructions === "string" ? params.instructions : undefined,
        commandId,
      );
    }
    if (method !== "turn.send") return undefined;
    if (!commandId) throw new Error("command_id_required");
    manager.assertMutable(String(params.threadId));
    const threadId = String(params.threadId),
      input = structuredClone(parse(UserInputSchema, params.input));
    if (params.mode !== "queue" && params.mode !== "steer") throw new Error("invalid_send_mode");
    const mode = params.mode;
    const outputMode =
      params.outputMode === undefined ? undefined : parse(OutputModeSchema, params.outputMode);
    const artifactTarget =
      params.artifactTarget === undefined
        ? undefined
        : parse(ArtifactTargetSchema, params.artifactTarget);
    if (artifactTarget && mode !== "queue") throw Error("artifact_target_queue_required");
    const perform = (validate?: (state: DomainState) => void) => {
      const id = randomUUID(),
        before = options.store.lastSeq();
      let produced = false;
      const receipt = options.store.dispatch(commandId, (state) => {
        produced = true;
        validate?.(state);
        check?.(state);
        if (artifactTarget) revisionTarget(options.store, threadId, artifactTarget);
        return queueHumanInput(
          state,
          {
            threadId,
            input,
            mode,
            ...(outputMode ? { outputMode } : {}),
            ...(artifactTarget ? { artifactTarget } : {}),
          },
          id,
          {
            commandId,
            at: new Date().toISOString(),
            actor: { kind: "human", id: "local-owner" },
          },
        );
      });
      const result = receipt.result;
      const saved = options.store
        .snapshot()
        .item?.find(
          (row) => row.id === result.id && row.threadId === threadId && row.kind === "user",
        );
      if (!saved) throw new Error("command_receipt_conflict");
      const body = parse(QueuedInputBodySchema, saved.body);
      if (
        (body.outputMode ?? "auto") !== (outputMode ?? "auto") ||
        JSON.stringify(body.artifactTarget) !== JSON.stringify(artifactTarget) ||
        body.mode !== mode ||
        JSON.stringify(body.input) !== JSON.stringify(input)
      )
        throw new Error("command_receipt_conflict");
      if (produced) {
        options.publish(options.store.eventsSince(before));
        void manager
          .ensure(threadId)
          .then((worker) => worker.wake())
          .catch(() => options.onError?.("runtime_open_failed"));
      }
      return result;
    };
    if (options.store.receipt(commandId)) return perform();
    return (async () => {
      if (artifactTarget) await prepareRevisionTarget(options.store, threadId, artifactTarget);
      return manager.prepareInput(input).then(perform);
    })();
  };
}
