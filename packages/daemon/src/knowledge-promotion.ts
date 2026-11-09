import { randomUUID } from "node:crypto";
import { KnowledgeItemSchema, parse, ScopeSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

/** A human-reviewed draft only; never persists or auto-promotes model output. */
export function knowledgePromotion(store: Store, params: Record<string, unknown>) {
  const task = store.record("task", String(params.taskId));
  if (!task?.threadId) throw new Error("task_not_found");
  const state = store.snapshot(["item", "turn"]);
  const items = (state.item ?? [])
    .filter((row) => row.threadId === task.threadId && row.kind === "message")
    .sort((a, b) => Number(b.seq) - Number(a.seq));
  const item = params.itemId
    ? items.find((row) => row.id === params.itemId)
    : (items.find((row) => row.phase === "final") ?? items[0]);
  const turn = state.turn?.find((row) => row.id === item?.turnId);
  const body = (item?.body as { text?: unknown })?.text;
  if (!item || !turn || typeof body !== "string") throw new Error("promotion_source_unavailable");
  const selected = typeof params.selectedText === "string" ? params.selectedText : body;
  if (!selected.trim() || selected.length > 1200 || !body.includes(selected))
    throw new Error("select_bounded_source_text");
  const input = state.item?.find(
    (row) => row.kind === "user" && row.threadId === task.threadId && row.turnId === turn.id,
  );
  const revisionMatch = String(input?.id).match(/:r(\d+):input$/);
  if (!revisionMatch) throw new Error("promotion_revision_unavailable");
  const revision = Number(revisionMatch[1]),
    at = new Date().toISOString();
  return parse(KnowledgeItemSchema, {
    id: `knowledge-${randomUUID()}`,
    scope: parse(ScopeSchema, task.node ?? { type: "project", id: task.projectId }),
    kind: "lesson",
    title: String(task.title).slice(0, 200),
    body: selected,
    tags: [],
    owner: { kind: "human", id: "local-owner" },
    verification: "human",
    writer: { kind: "human", id: "local-owner" },
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    sources: [
      {
        kind: "task",
        ref: String(task.id),
        label: `Task revision ${revision}`,
        taskRevision: revision,
        sessionId: String(turn.sessionId),
        turnId: String(turn.id),
        itemId: String(item.id),
        sourceText: selected,
        sourceReviewState:
          revision === task.revision
            ? task.state === "completed" && task.reviewState === "accept"
              ? "accepted"
              : task.state === "failed" && task.reviewState === "reject"
                ? "rejected"
                : "unreviewed"
            : "historical_unverified",
      },
    ],
  });
}
