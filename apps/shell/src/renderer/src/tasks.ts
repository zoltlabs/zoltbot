import type { TaskState, TaskSummary } from "../../shared/tasks";
import type { BotProfile } from "./data";

export type TaskGroup = "needs_you" | "running" | "queued" | "done";

export const TASK_GROUPS: { id: TaskGroup; title: string }[] = [
  { id: "needs_you", title: "Needs you" },
  { id: "running", title: "Running" },
  { id: "queued", title: "Queued" },
  { id: "done", title: "Done" },
];

const GROUP_OF: Record<TaskState, TaskGroup> = {
  review: "needs_you",
  failed: "needs_you",
  running: "running",
  blocked: "running",
  queued: "queued",
  completed: "done",
  cancelled: "done",
};

const STATE_LABELS: Record<TaskState, string> = {
  review: "Ready for review",
  failed: "Failed",
  running: "Running",
  blocked: "Blocked",
  queued: "Queued",
  completed: "Accepted",
  cancelled: "Stopped",
};

/** Tasks in the page's groups. Queued tasks keep their start order; the rest show newest first. */
export function groupTasks(tasks: readonly TaskSummary[]): Record<TaskGroup, TaskSummary[]> {
  const groups: Record<TaskGroup, TaskSummary[]> = {
    needs_you: [],
    running: [],
    queued: [],
    done: [],
  };
  for (const task of tasks) groups[GROUP_OF[task.state]].push(task);
  for (const [id, rows] of Object.entries(groups))
    rows.sort((a, b) =>
      id === "queued"
        ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        : b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  return groups;
}

/** The status pill: the state, then why it waits or failed, such as "Queued · at limit". */
export function statusLabel(task: Pick<TaskSummary, "state" | "reason">): string {
  return task.reason ? `${STATE_LABELS[task.state]} · ${task.reason}` : STATE_LABELS[task.state];
}

/** How many tasks wait for the person: results to review and failures. */
export function needsYouCount(tasks: readonly TaskSummary[]): number {
  return tasks.filter((task) => GROUP_OF[task.state] === "needs_you").length;
}

/** "now", "4m", "3h" or "2d" since `since`. */
export function taskAge(since: string, now: number): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function inProgress(task: Pick<TaskSummary, "state">): boolean {
  return task.state === "running" || task.state === "blocked" || task.state === "queued";
}

/** A task the person accepted or sent back, shown that way until the daemon catches up. */
export interface PendingReview {
  revision: number;
  state: TaskState;
}

/** Applies reviews still on their way to the daemon, so rows move the moment they're clicked. */
export function withPendingReviews(
  tasks: readonly TaskSummary[],
  pending: Record<string, PendingReview>,
): TaskSummary[] {
  return tasks.map((task) => {
    const review = pending[task.id];
    return review && task.state === "review" && task.revision === review.revision
      ? { ...task, state: review.state, reason: "", atLimit: false }
      : task;
  });
}

/** One employee's tasks in progress, shown as one sidebar row with a sub-row per task. */
export interface SidebarEmployee {
  key: string;
  name: string;
  /** The task chats, in sidebar order. */
  bots: BotProfile[];
  tasks: Map<string, TaskSummary>;
  running: number;
  queued: number;
}

export type SidebarEntry =
  | { kind: "bot"; bot: BotProfile }
  | { kind: "employee"; employee: SidebarEmployee };

/**
 * The sidebar's rows. Task chats of one employee (a profile in one project) under the same
 * manager collapse into one row when more than one of their tasks is in progress; every other
 * chat keeps its own row.
 */
export function sidebarEntries(
  bots: readonly BotProfile[],
  tasks: readonly TaskSummary[],
): SidebarEntry[] {
  const byThread = new Map<string, TaskSummary>();
  for (const task of tasks)
    if (task.threadId && inProgress(task)) byThread.set(task.threadId, task);
  const keyOf = (bot: BotProfile) => {
    const task = byThread.get(bot.id);
    return task?.owner && bot.kind === "task"
      ? `${bot.projectId ?? ""}/${bot.parentId ?? ""}/${task.owner.profileId}`
      : undefined;
  };
  const groups = new Map<string, BotProfile[]>();
  for (const bot of bots) {
    const key = keyOf(bot);
    if (key) groups.set(key, [...(groups.get(key) ?? []), bot]);
  }
  const entries: SidebarEntry[] = [];
  const placed = new Set<string>();
  for (const bot of bots) {
    const key = keyOf(bot);
    const members = key ? (groups.get(key) ?? []) : [];
    if (!key || members.length < 2) {
      entries.push({ kind: "bot", bot });
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    const own = new Map(members.map((member) => [member.id, byThread.get(member.id)]));
    const states = [...own.values()].map((task) => task?.state);
    entries.push({
      kind: "employee",
      employee: {
        key,
        name: byThread.get(bot.id)?.owner?.name || bot.role || bot.name,
        bots: members,
        tasks: own as Map<string, TaskSummary>,
        running: states.filter((state) => state === "running" || state === "blocked").length,
        queued: states.filter((state) => state === "queued").length,
      },
    });
  }
  return entries;
}

/**
 * Keeps each sidebar entry the same object while it shows the same thing, so the list only
 * re-renders rows that changed and focus stays put.
 */
export function stableEntries(): (entries: SidebarEntry[]) => SidebarEntry[] {
  const bots = new WeakMap<BotProfile, SidebarEntry>();
  let employees = new Map<string, { signature: string; entry: SidebarEntry }>();
  return (entries) => {
    const next = new Map<string, { signature: string; entry: SidebarEntry }>();
    const result = entries.map((entry) => {
      if (entry.kind === "bot") {
        const kept = bots.get(entry.bot) ?? entry;
        bots.set(entry.bot, kept);
        return kept;
      }
      const { employee } = entry;
      const signature = JSON.stringify([
        employee.name,
        employee.running,
        employee.queued,
        employee.bots.map((bot) => bot.id),
        [...employee.tasks.values()].map((task) => [task.id, task.state, task.title]),
      ]);
      const previous = employees.get(employee.key);
      const kept = previous?.signature === signature ? previous.entry : entry;
      next.set(employee.key, { signature, entry: kept });
      return kept;
    });
    employees = next;
    return result;
  };
}

/** "2 running · 1 queued", leaving out a zero count. */
export function employeeSummary(employee: Pick<SidebarEmployee, "running" | "queued">): string {
  return [
    employee.running ? `${employee.running} running` : "",
    employee.queued ? `${employee.queued} queued` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
