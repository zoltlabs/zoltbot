import { type Row, text } from "../chat/types.js";
import { object } from "../workspaces/view.js";

export type TaskGroup = "needs_you" | "running" | "queued" | "done";
export const groupTitles: Record<TaskGroup, string> = {
  needs_you: "Needs you",
  running: "Running",
  queued: "Queued",
  done: "Done",
};
const groupOf: Record<string, TaskGroup> = {
  review: "needs_you",
  failed: "needs_you",
  running: "running",
  blocked: "running",
  queued: "queued",
  completed: "done",
  cancelled: "done",
};
export const stateLabels: Record<string, string> = {
  review: "Needs review",
  failed: "Failed",
  running: "Running",
  blocked: "Waiting to resume",
  queued: "Queued",
  completed: "Accepted",
  cancelled: "Stopped",
};
/** Tasks grouped for the list, newest activity first, with done tasks capped. */
export function groupTasks(tasks: Row[], includeAllDone = false): Record<TaskGroup, Row[]> {
  const groups: Record<TaskGroup, Row[]> = { needs_you: [], running: [], queued: [], done: [] };
  for (const task of tasks) groups[groupOf[text(task.state)] ?? "done"].push(task);
  for (const key of Object.keys(groups) as TaskGroup[])
    groups[key].sort((a, b) =>
      key === "queued"
        ? text(a.createdAt).localeCompare(text(b.createdAt))
        : text(b.updatedAt).localeCompare(text(a.updatedAt)),
    );
  if (!includeAllDone) groups.done = groups.done.slice(0, 20);
  return groups;
}
/** The result for the task's current revision, if one was submitted. */
export function currentResult(task: Row, results: Row[]): Row | undefined {
  return results.find((row) => row.taskId === task.id && row.revision === task.revision);
}
/** Readable wording for a hold reason the daemon records as a code. */
export function holdText(task: Row): string {
  const reason = text(task.holdReason);
  if (reason === "daemon_restarted")
    return "Zoltbot restarted. It continues when its agent is available.";
  if (reason === "workspace_missing") return "Its folder is missing.";
  // The daemon records "The agent turn failed (code)"; show the code's meaning instead.
  const failed = /^The agent turn failed(?: \((\w+)\))?$/.exec(reason);
  if (failed)
    return (
      failureText[failed[1] ?? ""] ??
      "The agent stopped with an error. Open the conversation for details, then try again."
    );
  return reason;
}
const failureText: Record<string, string> = {
  auth_required: "The coding tool needs you to sign in again, then try again.",
  runtime_open_failed: "The coding tool could not start. Check it in Settings › Coding agents.",
  rate_limited: "The coding tool hit its usage limit. Try again later.",
};
/** "Zolt / Product / Food logging" for the task's workspace or team. */
export function placeName(task: Row, projects: Row[], directions: Row[]): string {
  const node = object(task.node);
  const names: string[] = [];
  let id = node.type === "subproject" ? text(node.id) : "";
  for (let hops = 0; id && hops < 4; hops++) {
    const row = directions.find((entry) => entry.id === id);
    if (!row) break;
    names.unshift(text(row.name));
    id = text(row.parentId);
  }
  const project = projects.find((row) => row.id === task.projectId);
  return [text(project?.name), ...names].filter(Boolean).join(" / ");
}
