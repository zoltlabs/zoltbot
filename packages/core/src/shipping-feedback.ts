import { parse, parseEvent, TaskSchema } from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

/** Explicit human reopening; preserves the native thread, workspace and accepted result history. */
export function applyShippingFeedback(
  state: DomainState,
  taskId: string,
  revision: number,
  text: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_task_required");
  const task = parse(
    TaskSchema,
    state.task?.find((t) => t.id === taskId),
  );
  if (task.revision !== revision) throw new Error("stale_revision");
  if (!["review", "completed", "failed"].includes(task.state))
    throw new Error("shipping_feedback_task_unavailable");
  if (!text.trim() || text.length > 16000) throw new Error("shipping_feedback_size");
  const thread = state.thread?.find((t) => t.id === task.threadId && !t.archived);
  if (!thread) throw new Error("thread_unavailable");
  // Replace the previous feedback suffix instead of accumulating external discussions in the brief.
  const original = task.brief.split("\n\nReview feedback:\n")[0] ?? task.brief;
  const next = parse(TaskSchema, {
    ...task,
    state: "queued",
    revision: revision + 1,
    reviewState: "changes",
    brief: `${original}\n\nReview feedback:\n${text}`,
    updatedAt: context.at,
  });
  return {
    events: [
      parseEvent({
        eventId: `${context.commandId}:task`,
        aggregateType: "task",
        aggregateId: taskId,
        type: "task.updated",
        occurredAt: context.at,
        payload: next,
      }),
    ],
    result: next,
  };
}
