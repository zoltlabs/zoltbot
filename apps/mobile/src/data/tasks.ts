import { AT_LIMIT_HOLD } from "@zoltbot/protocol";
import type { Row, Snapshot } from "./transport.js";

// Pure selectors for the Tasks tab and the drawer, ported from the desktop's tasks-view.ts and
// tasks.ts so both show the same groups, reasons and counts.

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export type TaskGroup = "needs_you" | "running" | "queued" | "done";
export const taskGroupOrder: TaskGroup[] = ["needs_you", "running", "queued", "done"];

const groupOf: Record<string, TaskGroup> = {
  review: "needs_you",
  failed: "needs_you",
  running: "running",
  blocked: "running",
  queued: "queued",
  completed: "done",
  cancelled: "done",
};

/** One task as the phone lists it. */
export interface TaskView {
  id: string;
  title: string;
  state: string;
  revision: number;
  /** Why it waits or failed, in a few words, such as "At limit". Empty when there's nothing to add. */
  reason: string;
  threadId: string | null;
  ownerId: string | null;
  ownerName: string;
  /** The manager chat the task reports to. */
  accountableThreadId: string | null;
  projectId: string | null;
  teamId: string | null;
  teamName: string;
  createdAt: string;
  updatedAt: string;
}

/** Every task in the snapshot, leaving out tasks in archived projects. */
export function taskViews(snapshot: Snapshot): TaskView[] {
  const entities = snapshot.entities;
  const projects = new Map((entities.project ?? []).map((row) => [text(row.id), row]));
  const teams = new Map((entities.subproject ?? []).map((row) => [text(row.id), row]));
  const profiles = new Map((entities.agent ?? []).map((row) => [text(row.id), row]));
  const threads = new Map((entities.thread ?? []).map((row) => [text(row.id), row]));
  const tasks = entities.task ?? [];
  const titles = new Map(tasks.map((row) => [text(row.id), text(row.title)]));
  const states = new Map(tasks.map((row) => [text(row.id), text(row.state)]));
  return tasks.flatMap((task): TaskView[] => {
    const projectId = text(task.projectId) || null;
    if (projectId && projects.get(projectId)?.archived === true) return [];
    const state = groupOf[text(task.state)] ? text(task.state) : "queued";
    const profile = profiles.get(text(task.ownerAgentId));
    const node = task.node as Row | undefined;
    const team = node?.type === "subproject" ? teams.get(text(node.id)) : undefined;
    const thread = threads.get(text(task.threadId));
    return [
      {
        id: text(task.id),
        title: text(task.title) || "Untitled task",
        state,
        revision: Number(task.revision) || 1,
        reason: taskReason(task, state, titles, states),
        threadId: thread && thread.archived !== true ? text(thread.id) : null,
        ownerId: profile ? text(profile.id) : null,
        ownerName: profile ? text(profile.name) || "Agent" : "",
        accountableThreadId: text(task.accountableThreadId) || null,
        projectId,
        teamId: team ? text(team.id) : null,
        teamName: text(team?.name),
        createdAt: text(task.createdAt),
        updatedAt: text(task.updatedAt) || text(task.createdAt),
      },
    ];
  });
}

const failures: Record<string, string> = {
  auth_required: "Sign-in needed",
  runtime_open_failed: "Couldn't start",
  rate_limited: "Usage limit",
  interaction_timeout: "Question timed out",
};

/**
 * A few words on why a task waits or failed, from the hold reason the daemon records. Unknown
 * reasons pass through, so nothing the daemon says is hidden.
 */
export function taskReason(
  task: Row,
  state: string,
  titles: Map<string, string>,
  states: Map<string, string>,
): string {
  const hold = text(task.holdReason).trim();
  if (state !== "queued" && state !== "blocked" && state !== "failed") return "";
  if (hold === "Waiting for accepted dependencies") {
    const dependencies = Array.isArray(task.dependencies) ? task.dependencies.map(text) : [];
    const open = dependencies.find((id) => states.get(id) !== "completed");
    return `Waits on ${(open && titles.get(open)) || "another task"}`;
  }
  if (state === "queued") {
    if (hold === AT_LIMIT_HOLD) return "At limit";
    const broken = /^Blocked by (\w+) dependency: (.+)$/.exec(hold);
    if (broken)
      return `${titles.get(broken[2] ?? "") || "Another task"} ${broken[1] === "failed" ? "failed" : "was stopped"}`;
    const folder = /^Waiting for ["“](.+)["”] to finish in /.exec(hold);
    if (folder) return `Waits on ${folder[1]}`;
    if (hold === "Planned work: awaiting dispatch") return "Planned";
    if (hold === "daemon_restarted") return "Zoltbot restarted";
    return upperFirst(hold);
  }
  if (state === "blocked") {
    if (hold === "daemon_restarted") return "Waiting to resume";
    return failures[hold] ?? upperFirst(hold);
  }
  const failed = /^The agent turn failed(?: \((\w+)\))?$/.exec(hold);
  if (failed) return failures[failed[1] ?? ""] ?? "";
  return failures[hold] ?? upperFirst(hold);
}

const upperFirst = (value: string) => value.slice(0, 1).toUpperCase() + value.slice(1);

/** Tasks in the tab's groups. Queued tasks keep their start order; the rest show newest first. */
export function groupTaskViews(tasks: readonly TaskView[]): Record<TaskGroup, TaskView[]> {
  const groups: Record<TaskGroup, TaskView[]> = {
    needs_you: [],
    running: [],
    queued: [],
    done: [],
  };
  for (const task of tasks) groups[groupOf[task.state] ?? "done"].push(task);
  for (const [key, rows] of Object.entries(groups))
    rows.sort((a, b) =>
      key === "queued"
        ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        : b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  return groups;
}

export interface TaskFilter {
  projectId?: string | null;
  teamId?: string | null;
  ownerId?: string | null;
}
export function filterTasks(tasks: readonly TaskView[], filter: TaskFilter): TaskView[] {
  return tasks.filter(
    (task) =>
      (!filter.projectId || task.projectId === filter.projectId) &&
      (!filter.teamId || task.teamId === filter.teamId) &&
      (!filter.ownerId || task.ownerId === filter.ownerId),
  );
}

export interface FilterOption {
  id: string;
  name: string;
}
/** The teams or owners the tasks have, sorted by name, for a filter's choices. */
export function filterOptions(tasks: readonly TaskView[], by: "team" | "owner"): FilterOption[] {
  const seen = new Map<string, string>();
  for (const task of tasks) {
    const id = by === "team" ? task.teamId : task.ownerId;
    if (id && !seen.has(id))
      seen.set(id, (by === "team" ? task.teamName : task.ownerName) || "Untitled");
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The pill a row shows, only where the group doesn't already say it. */
export function taskPill(
  state: string,
): { label: string; tone: "attention" | "danger" | "neutral" } | null {
  if (state === "review") return { label: "Review", tone: "attention" };
  if (state === "failed") return { label: "Failed", tone: "danger" };
  if (state === "blocked") return { label: "Blocked", tone: "neutral" };
  return null;
}

/** "now", "4m", "3h" or "2d" since `since`. */
export function taskAge(since: string, now = Date.now()): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "Sam · Web", with the reason or age after it for the compact rows. */
export function taskMeta(task: TaskView, now = Date.now(), withTail = true): string {
  const tail = withTail ? task.reason || taskAge(task.updatedAt, now) : "";
  return [task.ownerName || "No owner", task.teamName, tail].filter(Boolean).join(" · ");
}

/** Results to review and failures, optionally in one project. */
export function needsYouTasks(snapshot: Snapshot, projectId?: string | null): number {
  return filterTasks(taskViews(snapshot), { projectId: projectId ?? null }).filter(
    (task) => groupOf[task.state] === "needs_you",
  ).length;
}

export const inProgress = (state: string) =>
  state === "running" || state === "blocked" || state === "queued";
