import type { DomainState } from "@zoltbot/core";
import {
  confirmKnowledge,
  decideProposal,
  knowledgeHistory,
  revertKnowledge,
} from "@zoltbot/knowledge";
import {
  type DomainEvent,
  KnowledgeItemSchema,
  KnowledgeProposalSchema,
  parse,
  type Scope,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { readTaint } from "./knowledge-taint.js";
import type { PublicWriteCheck } from "./private-input.js";

const methods = new Set([
  "proposal.list",
  "proposal.decide",
  "knowledge.agentWrites",
  "knowledge.confirm",
  "knowledge.revert",
  "knowledge.writes",
]);
const owner = { kind: "human" as const, id: "local-owner" };
const day = 24 * 60 * 60 * 1000;

/** The project that owns a scope; the user scope belongs to every project. */
export function scopeProject(state: DomainState, scope: Scope) {
  if (scope.type === "project") return scope.id;
  const kind =
    scope.type === "subproject" ? "subproject" : scope.type === "task" ? "task" : undefined;
  const row = kind ? state[kind]?.find((entry) => entry.id === scope.id) : undefined;
  return typeof row?.projectId === "string" ? row.projectId : undefined;
}

/** Inbox knowledge proposals, the agent writes digest, confirm, revert and the per-run record. */
export function knowledgeReviewApi(options: {
  store: Store;
  publish(events: DomainEvent[]): void;
  checkPublic(value: unknown): Promise<PublicWriteCheck>;
}) {
  const { store } = options;
  const inProject = (state: DomainState, scope: Scope, projectId: unknown, includeUser = true) =>
    scope.type === "user"
      ? includeUser
      : typeof projectId !== "string" || scopeProject(state, scope) === projectId;
  async function command(
    commandId: string | undefined,
    params: unknown,
    produce: (
      state: DomainState,
      context: { commandId: string; at: string; actor: typeof owner },
    ) => {
      result: unknown;
      events: DomainEvent[];
    },
  ) {
    if (!commandId) throw new Error("command_id_required");
    const check = await options.checkPublic([params, commandId]);
    const before = store.lastSeq();
    const result = store.dispatch(commandId, (state) => {
      check(state);
      return produce(state, { commandId, at: new Date().toISOString(), actor: owner });
    }).result;
    options.publish(store.eventsSince(before));
    return result;
  }
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (!methods.has(method)) return undefined;
    const state = store.snapshot([
      "project",
      "subproject",
      "task",
      "knowledge",
      "knowledgeProposal",
    ]);
    if (method === "proposal.list") {
      const items = (state.knowledgeProposal ?? [])
        .map((row) => parse(KnowledgeProposalSchema, row))
        .filter(
          (row) =>
            (!params.state || row.state === params.state) &&
            inProject(state, row.scope, params.projectId),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
        .slice(0, 200);
      return { items };
    }
    if (method === "knowledge.agentWrites") {
      const since = typeof params.since === "string" ? params.since : undefined;
      const items = (state.knowledge ?? [])
        .map((row) => parse(KnowledgeItemSchema, row))
        .filter(
          (row) =>
            row.writer.kind === "agent" &&
            row.status === "active" &&
            (!since || row.updatedAt >= since) &&
            inProject(state, row.scope, params.projectId, params.includeUser !== false),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .slice(0, 200);
      return { items };
    }
    if (method === "knowledge.writes") {
      const task = params.taskId ? store.record("task", String(params.taskId)) : undefined;
      if (params.taskId && !task) throw new Error("task_not_found");
      const threadId = String(task?.threadId ?? params.threadId ?? "");
      const writes = store.database
        .prepare(
          "SELECT id,session_id AS sessionId,task_id AS taskId,thread_id AS threadId,source,op,outcome,reason,item_id AS itemId,revision,proposal_id AS proposalId,scope_type AS scopeType,scope_id AS scopeId,kind,title,at FROM knowledge_writes_aux WHERE (task_id=? OR thread_id=?) ORDER BY at,id",
        )
        .all(params.taskId ?? null, threadId) as Record<string, unknown>[];
      const threads = new Set(
        (store.snapshot(["thread"]).thread ?? [])
          .filter((row) => row.id === threadId || (params.taskId && row.taskId === params.taskId))
          .map((row) => String(row.id)),
      );
      const sessions = [
        ...new Set([
          ...(store.snapshot(["session"]).session ?? [])
            .filter((row) => threads.has(String(row.threadId)))
            .map((row) => String(row.id)),
          ...writes.map((row) => String(row.sessionId)),
        ]),
      ];
      return {
        writes: writes.map((row) =>
          Object.fromEntries(
            Object.entries({
              ...row,
              scope: row.scopeType ? { type: row.scopeType, id: row.scopeId } : undefined,
              scopeType: undefined,
              scopeId: undefined,
            }).filter(([, value]) => value !== null && value !== undefined),
          ),
        ),
        taint: readTaint(store, sessions),
      };
    }
    if (method === "proposal.decide")
      return command(commandId, params, (snapshot, context) => {
        const outcome = decideProposal(
          snapshot,
          params as Parameters<typeof decideProposal>[1],
          context,
        );
        return { result: { ok: true }, events: outcome.events };
      });
    const id = String(params.id),
      expected = Number(params.expectedRevision);
    if (method === "knowledge.confirm")
      return command(commandId, params, (snapshot, context) => {
        const outcome = confirmKnowledge(snapshot, id, expected, context);
        return { result: outcome.result, events: outcome.events };
      });
    if (params.confirmed !== true) throw new Error("confirmation_required");
    const history = knowledgeHistory(store, id);
    return command(commandId, params, (snapshot, context) => {
      const outcome = revertKnowledge(snapshot, history, id, expected, context);
      return { result: outcome.result, events: outcome.events };
    });
  };
}
export const digestSince = (now = Date.now()) => new Date(now - day).toISOString();
