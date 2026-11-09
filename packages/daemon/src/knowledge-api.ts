import { randomUUID } from "node:crypto";
import { type DomainState, handle, holdTask } from "@zoltbot/core";
import {
  buildKnowledgePack,
  eligibleKnowledge,
  frozenKnowledgePack,
  knowledgeHistory,
  knowledgeMatches,
  upsertKnowledge,
} from "@zoltbot/knowledge";
import { type DomainEvent, KnowledgeItemSchema, parse, ScopeSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { knowledgePromotion } from "./knowledge-promotion.js";
import { knowledgeReviewApi } from "./knowledge-review-api.js";
import { knowledgeUpdate } from "./knowledge-update.js";
import type { PublicWriteCheck } from "./private-input.js";

export function knowledgeApi(options: {
  store: Store;
  wake?(threadId: string): Promise<void>;
  publish(events: DomainEvent[]): void;
  checkPublic(value: unknown): Promise<PublicWriteCheck>;
}) {
  const { store } = options;
  const review = knowledgeReviewApi(options);
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    const reviewed = await review(method, params, commandId);
    if (reviewed !== undefined) return reviewed;
    if (
      ![
        "knowledge.sendUpdate",
        "knowledge.promoteDraft",
        "knowledge.exclude",
        "knowledge.list",
        "knowledge.get",
        "knowledge.upsert",
        "knowledge.archive",
        "knowledge.revisions",
        "contextPack.get",
        "inspector.get",
        "knowledge.preview",
      ].includes(method)
    )
      return undefined;
    const current = (id: string) => {
      const row = store.record("knowledge", id);
      if (!row) throw new Error("knowledge_not_found");
      return parse(KnowledgeItemSchema, row);
    };
    if (method === "knowledge.sendUpdate") {
      if (!commandId) throw new Error("command_id_required");
      const check = await options.checkPublic([params, commandId]);
      check(store.snapshot());
      return knowledgeUpdate(options, params, commandId);
    }
    if (method === "knowledge.promoteDraft") return knowledgePromotion(store, params);
    if (method === "knowledge.exclude") {
      if (!commandId) throw new Error("command_id_required");
      if (params.confirmed !== true) throw new Error("confirmation_required");
      const check = await options.checkPublic([params, commandId]);
      const before = store.lastSeq();
      const result = store.dispatch(commandId, (state) => {
        check(state);
        const task = state.task?.find((row) => row.id === params.taskId);
        if (!task || task.state !== "queued" || frozenKnowledgePack(store, String(task.id)))
          throw new Error("knowledge_already_frozen");
        const scope = parse(ScopeSchema, { type: "task", id: task.id });
        const allowed = new Set(eligibleKnowledge(state, scope).map((row) => row.id));
        const ids = params.ids as string[];
        if (!Array.isArray(ids) || ids.some((id) => !allowed.has(id)))
          throw new Error("knowledge_scope_mismatch");
        const context = {
          commandId,
          actor: { kind: "human" as const, id: "local-owner" },
          at: new Date().toISOString(),
        };
        const key = `knowledge.exclusions.${String(task.id)}`;
        const value = { ids, confirmed: true, taskRevision: task.revision, at: context.at };
        const event = handle(
          state,
          state.settings?.some((row) => row.key === key)
            ? { type: "update", kind: "settings", id: key, changes: { value } }
            : { type: "create", kind: "settings", value: { key, value } },
          context,
        );
        const released = holdTask(state, String(task.id), undefined, context);
        const audit = handle(
          state,
          {
            type: "create",
            kind: "audit",
            value: {
              id: commandId,
              actor: context.actor,
              action: "knowledge.exclude",
              target: task.id,
              result: "allowed",
              detail: { ids, confirmed: true },
              at: context.at,
            },
          },
          context,
        );
        return {
          result: { ok: true },
          events: [...event.events, ...audit.events, ...released.events].map((entry, index) => ({
            ...entry,
            eventId: `${commandId}:${index}`,
          })),
        };
      }).result;
      options.publish(store.eventsSince(before));
      return result;
    }
    if (method === "knowledge.get") return current(String(params.id));
    if (method === "knowledge.revisions") {
      current(String(params.id));
      return knowledgeHistory(store, String(params.id));
    }
    if (method === "knowledge.list") {
      const state = store.snapshot(["project", "subproject", "knowledge", "task", "settings"]);
      // No implicit global corpus: callers must choose a project or narrower scope.
      const scope = parse(ScopeSchema, params.scope ?? { type: "project", id: params.projectId });
      const query = typeof params.query === "string" ? params.query : "";
      const matches = knowledgeMatches(store, state, scope, query);
      const all = eligibleKnowledge(state, scope)
        .filter(
          (row) =>
            matches.has(row.id) &&
            (!params.kind || row.kind === params.kind) &&
            (!params.status || row.status === params.status),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const after = params.cursor ? all.filter((row) => row.id > String(params.cursor)) : all;
      const limit = Math.min(200, Number(params.limit) || 50),
        items = after.slice(0, limit);
      return { items, ...(after.length > limit ? { cursor: items.at(-1)?.id } : {}) };
    }
    if (method === "knowledge.preview") {
      const state = store.snapshot(["project", "subproject", "knowledge", "task", "settings"]);
      const scope = parse(ScopeSchema, params.scope);
      return buildKnowledgePack(
        state,
        {
          id: "preview",
          taskId: "preview",
          revision: 1,
          scope,
          query: String(params.query ?? ""),
          at: new Date().toISOString(),
          remainingTokens: Number(params.remainingTokens ?? 1200),
        },
        knowledgeMatches(store, state, scope, String(params.query ?? "")),
      );
    }
    if (method === "contextPack.get" || method === "inspector.get") {
      const taskId = String(params.taskId);
      if (!store.record("task", taskId)) throw new Error("task_not_found");
      // A task revision fence does not imply another native execution.
      const pack = frozenKnowledgePack(store, taskId);
      if (method === "contextPack.get") {
        if (!pack) throw new Error("context_pack_not_started");
        return pack;
      }
      const reads = store.database
        .prepare(
          "SELECT id,session_id AS sessionId,item_ids AS itemIds,token_estimate AS tokenEstimate,at FROM knowledge_reads_aux WHERE task_id=? ORDER BY at,id",
        )
        .all(taskId);
      return {
        ...(pack ? { pack } : {}),
        reads,
        injectedTokens:
          (pack?.tokenEstimate ?? 0) +
          (reads as { tokenEstimate: number }[]).reduce((sum, read) => sum + read.tokenEstimate, 0),
      };
    }
    if (!commandId) throw new Error("command_id_required");
    if (store.receipt(commandId)) return store.receipt(commandId)?.result;
    const value =
      method === "knowledge.archive"
        ? { ...current(String(params.id)), status: "archived" }
        : parse(KnowledgeItemSchema, params.value);
    // Archive checks the revision the caller saw when it sends one, as upsert always does.
    const expected =
      method === "knowledge.archive" && typeof params.expectedRevision !== "number"
        ? current(String(params.id)).revision
        : Number(params.expectedRevision);
    const check = await options.checkPublic([value, commandId]);
    const before = store.lastSeq();
    const result = store.dispatch(commandId, (state: DomainState) => {
      check(state);
      return upsertKnowledge(state, value, expected, {
        commandId,
        actor: { kind: "human", id: "local-owner" },
        at: new Date().toISOString(),
      });
    }).result;
    options.publish(store.eventsSince(before));
    return method === "knowledge.archive" ? { ok: true } : result;
  };
}
export const knowledgeId = () => `knowledge-${randomUUID()}`;
