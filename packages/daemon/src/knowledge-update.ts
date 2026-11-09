import { randomUUID } from "node:crypto";
import { applyEvents, handle, queueHumanInput } from "@zoltbot/core";
import { eligibleKnowledge, estimateKnowledgeTokens, renderKnowledge } from "@zoltbot/knowledge";
import { type DomainEvent, parse, ScopeSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export function knowledgeUpdate(
  options: {
    store: Store;
    publish(events: DomainEvent[]): void;
    wake?(threadId: string): Promise<void>;
  },
  params: Record<string, unknown>,
  commandId: string,
) {
  if (params.confirmed !== true) throw new Error("confirmation_required");
  const before = options.store.lastSeq();
  const receipt = options.store.dispatch(commandId, (state) => {
    const task = state.task?.find((row) => row.id === params.taskId);
    if (
      !task ||
      typeof task.threadId !== "string" ||
      !["running", "review", "blocked"].includes(String(task.state))
    )
      throw new Error("knowledge_update_task_unavailable");
    const session = state.session
      ?.filter((row) => row.threadId === task.threadId && typeof row.nativeId === "string")
      .at(-1);
    if (!session) throw new Error("knowledge_update_session_unavailable");
    const scope = parse(ScopeSchema, { type: "task", id: task.id });
    const ids = params.ids as string[];
    if (!Array.isArray(ids) || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length)
      throw new Error("invalid_knowledge_selection");
    const eligible = eligibleKnowledge(state, scope);
    const items = ids.map((id) => eligible.find((row) => row.id === id && row.status === "active"));
    if (items.some((item) => !item)) throw new Error("knowledge_scope_mismatch");
    const text =
      "[Human-requested knowledge update]\n" +
      items.map((item) => (item ? renderKnowledge(item) : "")).join("\n\n");
    const tokens = estimateKnowledgeTokens(text);
    if (tokens > 1200) throw new Error("knowledge_update_over_budget");
    const at = new Date().toISOString(),
      context = { commandId, at, actor: { kind: "human" as const, id: "local-owner" } };
    const queued = queueHumanInput(
      state,
      { threadId: task.threadId, input: [{ type: "text", text }], mode: "queue" },
      `knowledge-update-${randomUUID()}`,
      context,
    );
    const audit = handle(
      applyEvents(state, queued.events),
      {
        type: "create",
        kind: "audit",
        value: {
          id: `knowledge-update:${commandId}`,
          actor: context.actor,
          action: "knowledge.sendUpdate",
          target: task.id,
          result: "allowed",
          detail: { ids, tokens, confirmed: true, sessionId: session.id },
          at,
        },
      },
      context,
    );
    options.store.database
      .prepare(
        "INSERT INTO knowledge_reads_aux(id,task_id,session_id,query,item_ids,at,token_estimate) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        `update:${commandId}`,
        task.id,
        session.id,
        "[explicit human update]",
        JSON.stringify(ids),
        at,
        tokens,
      );
    return {
      result: { ok: true, threadId: task.threadId },
      events: [...queued.events, ...audit.events].map((event, index) => ({
        ...event,
        eventId: `${commandId}:${index}`,
      })),
    };
  });
  options.publish(options.store.eventsSince(before));
  void options.wake?.(String(receipt.result.threadId)).catch(() => {});
  return { ok: true };
}
