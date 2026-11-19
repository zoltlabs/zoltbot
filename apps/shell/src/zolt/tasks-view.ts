import { AT_LIMIT_HOLD } from "@zoltbot/protocol";
import { TASK_STATES, type TaskState, type TaskSummary } from "../shared/tasks";
import type { Row, Snapshot } from "./daemon-client";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Every task in the daemon's snapshot, as the Tasks page lists it: its state, the employee that
 * runs it (the owner profile), its team and a short reason when it waits or failed. Tasks in an
 * archived project are left out.
 */
export function toTaskSummaries(snapshot: Snapshot): TaskSummary[] {
  const entities = snapshot.entities;
  const projects = new Map((entities.project ?? []).map((row) => [text(row.id), row]));
  const teams = new Map((entities.subproject ?? []).map((row) => [text(row.id), row]));
  const profiles = new Map((entities.agent ?? []).map((row) => [text(row.id), row]));
  const threads = new Map((entities.thread ?? []).map((row) => [text(row.id), row]));
  const tasks = entities.task ?? [];
  const titles = new Map(tasks.map((row) => [text(row.id), text(row.title)]));
  const states = new Map(tasks.map((row) => [text(row.id), text(row.state)]));

  return tasks.flatMap((task): TaskSummary[] => {
    const projectId = text(task.projectId) || null;
    const project = projectId ? projects.get(projectId) : undefined;
    if (project?.archived === true) return [];
    const state = TASK_STATES.includes(task.state as TaskState)
      ? (task.state as TaskState)
      : "queued";
    const profile = profiles.get(text(task.ownerAgentId));
    const node = task.node as Row | undefined;
    const team = node?.type === "subproject" ? teams.get(text(node.id)) : undefined;
    const thread = threads.get(text(task.threadId));
    return [
      {
        id: text(task.id),
        title: text(task.title) || "Untitled task",
        projectId,
        projectName: text(project?.name),
        state,
        revision: Number(task.revision) || 1,
        reason: taskReason(task, state, titles, states),
        atLimit: state === "queued" && task.holdReason === AT_LIMIT_HOLD,
        threadId: thread && thread.archived !== true ? text(thread.id) : null,
        owner: profile
          ? { profileId: text(profile.id), name: text(profile.name) || "Agent" }
          : null,
        teamId: team ? text(team.id) : null,
        teamName: text(team?.name),
        createdAt: text(task.createdAt),
        updatedAt: text(task.updatedAt) || text(task.createdAt),
      },
    ];
  });
}

const FAILURES: Record<string, string> = {
  auth_required: "sign-in needed",
  runtime_open_failed: "couldn't start",
  rate_limited: "usage limit",
  interaction_timeout: "question timed out",
};

/**
 * A few words on why a task waits or failed, from the hold reason the daemon records. Unknown
 * reasons pass through, so nothing the daemon says is hidden.
 */
export function taskReason(
  task: Row,
  state: TaskState,
  titles: Map<string, string>,
  states: Map<string, string>,
): string {
  const hold = text(task.holdReason);
  if (state === "queued") {
    if (hold === AT_LIMIT_HOLD) return "at limit";
    if (hold === "Waiting for accepted dependencies") {
      const dependencies = Array.isArray(task.dependencies) ? task.dependencies.map(text) : [];
      const open = dependencies.find((id) => states.get(id) !== "completed");
      return open ? `waits on ${titles.get(open) || "another task"}` : "waits on another task";
    }
    const broken = /^Blocked by (\w+) dependency: (.+)$/.exec(hold);
    if (broken)
      return `${titles.get(broken[2] ?? "") || "another task"} ${broken[1] === "failed" ? "failed" : "was stopped"}`;
    const folder = /^Waiting for "(.+)" to finish in /.exec(hold);
    if (folder) return `waits on ${folder[1]}`;
    if (hold === "Planned work: awaiting dispatch") return "planned";
    if (hold === "daemon_restarted") return "Zoltbot restarted";
    return lowerFirst(hold);
  }
  if (state === "blocked") {
    if (hold === "daemon_restarted") return "waiting to resume";
    return FAILURES[hold] ?? lowerFirst(hold);
  }
  if (state === "failed") {
    const failed = /^The agent turn failed(?: \((\w+)\))?$/.exec(hold);
    if (failed) return FAILURES[failed[1] ?? ""] ?? "";
    return FAILURES[hold] ?? lowerFirst(hold);
  }
  return "";
}

function lowerFirst(value: string): string {
  return /^[A-Z][a-z]/.test(value) ? `${value.slice(0, 1).toLowerCase()}${value.slice(1)}` : value;
}
