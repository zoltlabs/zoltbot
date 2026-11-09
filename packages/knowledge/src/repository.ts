import { randomUUID } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import {
  ContextPackSchema,
  KnowledgeItemSchema,
  parse,
  parseEvent,
  type Scope,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import {
  eligibleKnowledge,
  estimateKnowledgeTokens,
  matchQuery,
  rankKnowledge,
} from "./retrieval.js";

export function knowledgeHistory(store: Store, id: string) {
  return (
    store.database
      .prepare(
        "SELECT body FROM knowledge_revision_snapshots WHERE item_id=? ORDER BY revision DESC",
      )
      .all(id) as { body: string }[]
  ).map((row) => parse(KnowledgeItemSchema, JSON.parse(row.body)));
}
/** FTS performs boolean matching only. All scoring uses the authorized lineage alone. */
export function knowledgeMatches(store: Store, state: DomainState, scope: Scope, query: string) {
  const eligible = new Set(eligibleKnowledge(state, scope).map((row) => row.id));
  const expression = matchQuery(query);
  if (!expression) return eligible;
  const rows = store.database
    .prepare("SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH ?")
    .all(expression) as { id: string }[];
  return new Set(rows.filter((row) => eligible.has(row.id)).map((row) => row.id));
}
export function freezeKnowledgePack(store: Store, commandId: string, value: unknown) {
  const pack = parse(ContextPackSchema, value);
  const existing = store.record("contextPack", pack.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(pack))
    throw new Error("immutable_context_pack");
  if (existing) return parse(ContextPackSchema, existing);
  return store.dispatch(commandId, () => ({
    result: pack,
    events: [
      parseEvent({
        eventId: `${commandId}:0`,
        aggregateType: "contextPack",
        aggregateId: pack.id,
        type: "contextPack.created",
        occurredAt: pack.createdAt,
        payload: pack,
      }),
    ],
  })).result;
}
export function frozenKnowledgePack(store: Store, taskId: string) {
  const rows = (store.snapshot(["contextPack"]).contextPack ?? [])
    .filter((row) => row.taskId === taskId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return rows[0] ? parse(ContextPackSchema, rows[0]) : undefined;
}
export function readKnowledge(
  store: Store,
  authority: { scope: Scope; sessionId: string; taskId?: string },
  query: string,
) {
  const state = store.snapshot(["project", "subproject", "knowledge", "task", "settings"]);
  const ranked = rankKnowledge(
    state,
    authority.scope,
    query,
    new Date().toISOString(),
    knowledgeMatches(store, state, authority.scope, query),
  );
  const exact = query.startsWith("id:") ? query.slice(3) : undefined;
  if (exact)
    ranked.items = rankKnowledge(state, authority.scope, "", new Date().toISOString()).items.filter(
      (item) => item.id === exact,
    );
  const result: { items: { id: string; revision: number; text: string }[]; truncated: boolean } = {
    items: [],
    truncated: false,
  };
  for (const item of ranked.items.slice(0, 10)) {
    const text = exact
      ? `${item.title.slice(0, 200)}\n${item.body}`
      : `${item.title}\n${item.body}`.slice(0, 400);
    result.items.push({ id: item.id, revision: item.revision, text });
    if (JSON.stringify(result).length > 4000) {
      result.items.pop();
      result.truncated = true;
      break;
    }
  }
  result.truncated ||= ranked.items.length > result.items.length;
  store.database
    .prepare(
      "INSERT INTO knowledge_reads_aux(id,task_id,session_id,query,item_ids,at,token_estimate) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      authority.taskId ?? null,
      authority.sessionId,
      null, // Search text may contain private input; audit identities, not raw queries.
      JSON.stringify(result.items.map((row) => row.id)),
      new Date().toISOString(),
      estimateKnowledgeTokens(JSON.stringify(result)),
    );
  return { result, tokens: estimateKnowledgeTokens(JSON.stringify(result)) };
}
