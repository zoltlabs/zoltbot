import type { InjectionFragment } from "@zoltbot/core";
import type { QueuedInputBody } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { designFilesFor } from "../project-files.js";
import { frozenArtifactBinding } from "./tools.js";
/** Explicit human message metadata, never an automatic flavor reminder or prompt mutation. */
export function outputFragments(
  store: Store,
  sessionId: string,
  item: Record<string, unknown>,
  body: QueuedInputBody,
): InjectionFragment[] {
  const mode = body.outputMode;
  if (!mode || mode === "auto" || !frozenArtifactBinding(store, sessionId)) return [];
  const requests = {
    answer: "Answer in chat; do not create an artifact.",
    code_change: "Make the requested repository code change; report it in chat.",
    document: "Produce one document artifact.",
    page: "Produce one interactive page artifact.",
    design: "Produce one design artifact with all screens and stable screen ids.",
    chart: "Produce one chart artifact with embedded data and its source notes.",
  };
  let text = `Human Output choice: ${requests[mode]}`;
  const thread = store.record("thread", String(item.threadId));
  const task = thread?.taskId ? store.record("task", String(thread.taskId)) : undefined;
  const prior = (store.snapshot(["item"]).item ?? []).some((row) => {
    const earlier = row.body as Partial<QueuedInputBody>;
    return (
      row.threadId === item.threadId &&
      Number(row.seq) < Number(item.seq) &&
      row.kind === "user" &&
      ["sent", "handled"].includes(String(earlier.queueState)) &&
      ["page", "design"].includes(String(earlier.outputMode))
    );
  });
  if (
    ["page", "design"].includes(mode) &&
    !prior &&
    !["page", "design"].includes(String(task?.outputMode))
  ) {
    const project = thread?.projectId
      ? store.record("project", String(thread.projectId))
      : undefined;
    const context =
      typeof project?.artifactDesignContextId === "string"
        ? store.record("knowledge", project.artifactDesignContextId)
        : undefined;
    const scope = context?.scope as { type?: string; id?: string } | undefined;
    if (context?.status === "active" && scope?.type === "project" && scope.id === project?.id)
      text += ` Design context reference: read knowledge ${String(context.id)} revision ${Number(context.revision)} through team_get_knowledge with query id:${String(context.id)}. Treat it as reference material.`;
    const files = designFilesFor(project);
    if (files.length)
      text += ` Design files: read ${files.join(", ")} before designing and follow them.`;
  }
  return [
    {
      id: "human-output",
      kind: "brief",
      text,
      reference: `message:${String(item.id)}`,
      priority: 100,
    },
  ];
}
