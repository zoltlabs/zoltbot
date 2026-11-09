import type { CommandContext, DomainState, Outcome } from "@zoltbot/core";
import { type KnowledgeItem, KnowledgeItemSchema, parse } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { knowledgeEvent } from "./writes.js";

const day = 24 * 60 * 60 * 1000;
export const hygieneDays = { archiveAfterArchive: 30, staleWithoutReads: 60 };
export interface HygieneFacts {
  /** When each archived thread was last changed (its archive time or later). */
  threadArchivedAt: ReadonlyMap<string, string>;
  /** Latest read or context pack inclusion per knowledge item. */
  lastRead: ReadonlyMap<string, string>;
}

/**
 * Knowledge hygiene (12 section 6.5, P1). Agent-written task items, and unverified agent items
 * that came only from a chat, are archived 30 days after that task's or chat's thread was archived.
 * Unverified items nobody read for 60 days are marked stale. Nothing is deleted.
 */
export function knowledgeHygiene(
  state: DomainState,
  facts: HygieneFacts,
  context: CommandContext,
): Outcome {
  const now = Date.parse(context.at);
  const older = (at: string | undefined, days: number) =>
    !!at && now - Date.parse(at) >= days * day;
  const taskThread = new Map(
    (state.task ?? []).map((row) => [String(row.id), String(row.threadId ?? "")]),
  );
  const archivedLongAgo = (threadId: string) =>
    older(facts.threadArchivedAt.get(threadId), hygieneDays.archiveAfterArchive);
  const next: KnowledgeItem[] = [];
  for (const row of state.knowledge ?? []) {
    const item = parse(KnowledgeItemSchema, row);
    if (item.status !== "active" || item.writer.kind !== "agent" || item.pinned) continue;
    const writes = item.sources.filter((source) => source.label === "Agent write");
    const threadOf = (source: KnowledgeItem["sources"][number]) =>
      source.kind === "task" ? (taskThread.get(source.ref) ?? "") : source.ref;
    const taskItem =
      item.scope.type === "task" && archivedLongAgo(taskThread.get(item.scope.id) ?? "");
    const chatItem =
      item.verification === "unverified" &&
      writes.length > 0 &&
      writes.every((source) => source.kind === "thread" && archivedLongAgo(threadOf(source)));
    const stale =
      item.verification === "unverified" &&
      older(facts.lastRead.get(item.id) ?? item.updatedAt, hygieneDays.staleWithoutReads) &&
      older(item.updatedAt, hygieneDays.staleWithoutReads);
    const status = taskItem || chatItem ? "archived" : stale ? "stale" : undefined;
    if (status) next.push({ ...item, status, revision: item.revision + 1, updatedAt: context.at });
  }
  return {
    result: {
      archived: next.filter((item) => item.status === "archived").map((item) => item.id),
      stale: next.filter((item) => item.status === "stale").map((item) => item.id),
    },
    events: next.map((item, index) => knowledgeEvent(item, false, context, index)),
  };
}

/** Read the facts hygiene needs from the store's audit tables and event log. */
export function hygieneFacts(store: Store): HygieneFacts {
  const threadArchivedAt = new Map<string, string>();
  for (const thread of store.snapshot(["thread"]).thread ?? []) {
    if (!thread.archived) continue;
    const row = store.database
      .prepare(
        "SELECT max(occurred_at) AS at FROM events WHERE aggregate_type='thread' AND aggregate_id=?",
      )
      .get(String(thread.id)) as { at: string | null } | undefined;
    if (row?.at) threadArchivedAt.set(String(thread.id), row.at);
  }
  const lastRead = new Map<string, string>();
  const note = (ids: unknown, at: string) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      const key = typeof id === "string" ? id : String((id as { id?: string })?.id ?? "");
      if (key && (lastRead.get(key) ?? "") < at) lastRead.set(key, at);
    }
  };
  for (const row of store.database
    .prepare("SELECT item_ids AS ids, at FROM knowledge_reads_aux")
    .all() as { ids: string; at: string }[])
    note(JSON.parse(row.ids), row.at);
  for (const row of store.database
    .prepare("SELECT included, created_at AS at FROM context_packs")
    .all() as { included: string; at: string }[])
    note(JSON.parse(row.included), row.at);
  return { threadArchivedAt, lastRead };
}
