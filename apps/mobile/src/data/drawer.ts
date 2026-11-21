import { mutedKey } from "@zoltbot/protocol";
import { chiefThreadId } from "@zoltbot/ui/chief/data";
import { inProgress, type TaskView, taskAge } from "./tasks.js";
import type { Row, Snapshot } from "./transport.js";

// What the drawer lists for one project: its channels, its people and its other chats. Mirrors
// the desktop sidebar (company-tree.ts, SidebarChannels, SidebarEmployee).

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const live = (row: Row) => row.archived !== true;

export interface ProjectOption {
  id: string;
  name: string;
}
export function drawerProjects(snapshot: Snapshot): ProjectOption[] {
  return (snapshot.entities.project ?? [])
    .filter(live)
    .map((row) => ({ id: text(row.id), name: text(row.name) || "Project" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The project a thread belongs to, by its own field, its node or its task. */
export function threadProject(snapshot: Snapshot, thread: Row): string | null {
  const direct = text(thread.projectId);
  if (direct) return direct;
  const node = thread.node as Row | undefined;
  if (node?.type === "project") return text(node.id);
  if (node?.type === "subproject")
    return text(snapshot.entities.subproject?.find((row) => row.id === node.id)?.projectId) || null;
  const task = snapshot.entities.task?.find((row) => row.id === thread.taskId);
  return text(task?.projectId) || null;
}

/** The chosen project if it still exists, else the one with the newest chat activity. */
export function resolveProject(snapshot: Snapshot, chosen: string | null): string | null {
  const projects = drawerProjects(snapshot);
  if (chosen && projects.some((project) => project.id === chosen)) return chosen;
  let best: { id: string; at: string } | null = null;
  for (const thread of snapshot.entities.thread ?? []) {
    const id = threadProject(snapshot, thread);
    if (!id || !projects.some((project) => project.id === id)) continue;
    const at = text(thread.lastActivityAt);
    if (!best || at > best.at) best = { id, at };
  }
  return best?.id ?? projects[0]?.id ?? null;
}

export interface ChannelRow {
  id: string;
  name: string;
  /** Requests still open or running. */
  active: number;
}
/** The project's channels: the project-wide one first, then teams by name. */
export function channelRows(
  channels: readonly Row[],
  requests: readonly Row[],
  projectId: string | null,
): ChannelRow[] {
  return channels
    .filter((row) => row.projectId === projectId && !row.archivedAt)
    .sort(
      (a, b) =>
        Number(b.kind === "project") - Number(a.kind === "project") ||
        text(a.name).localeCompare(text(b.name)),
    )
    .map((row) => ({
      id: text(row.id),
      name: text(row.name),
      active: requests.filter(
        (request) =>
          request.channelId === row.id && (request.state === "open" || request.state === "running"),
      ).length,
    }));
}

export type PersonRole = "ceo" | "manager" | "employee";
export interface PersonRow {
  key: string;
  name: string;
  role: PersonRole;
  /** The id the avatar's color comes from: the chat for managers, the profile for employees. */
  avatarId: string;
  /** The chat a tap opens; null for an employee whose tasks expand instead. */
  threadId: string | null;
  meta: string;
  /** An employee's tasks, when there's more than one to show. */
  tasks: TaskView[];
}

const stateWords: Record<string, string> = {
  running: "Running",
  blocked: "Blocked",
  queued: "Queued",
  review: "Review",
  failed: "Failed",
};
export const taskStateWord = (state: string) => stateWords[state] ?? "";

const active = (task: TaskView) =>
  inProgress(task.state) || task.state === "review" || task.state === "failed";

/** "2 running · 1 to review · 1 queued", leaving out a zero count. */
export function workSummary(tasks: readonly TaskView[]): string {
  const count = (...states: string[]) => tasks.filter((task) => states.includes(task.state)).length;
  const running = count("running", "blocked");
  const review = count("review");
  const failed = count("failed");
  const queued = count("queued");
  return [
    running ? `${running} running` : "",
    review ? `${review} to review` : "",
    failed ? `${failed} failed` : "",
    queued ? `${queued} queued` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const waiting = (count: number) => `Waiting on ${count} ${count === 1 ? "task" : "tasks"}`;

/**
 * The project's CEO, its managers and the employees with work in progress. A manager's line says
 * how many tasks it waits on; an employee's says what its one task is doing, or its counts when
 * it has several.
 */
export function drawerPeople(
  snapshot: Snapshot,
  projectId: string | null,
  tasks: readonly TaskView[],
): PersonRow[] {
  if (!projectId) return [];
  const own = tasks.filter((task) => task.projectId === projectId);
  const managers = (snapshot.entities.thread ?? []).filter(
    (thread) =>
      live(thread) && thread.kind === "manager" && threadProject(snapshot, thread) === projectId,
  );
  const teams = snapshot.entities.subproject ?? [];
  const ceo =
    managers.find((m) => (m.node as Row | undefined)?.type === "project") ??
    managers.find((m) => !(m.node as Row | undefined)?.type);
  const name = (thread: Row) =>
    text(thread.title).trim() ||
    text(snapshot.entities.agent?.find((row) => row.id === thread.agentId)?.name) ||
    "Manager";
  const managerRow = (thread: Row, role: PersonRole): PersonRow => {
    const id = text(thread.id);
    const delegated = own.filter(
      (task) => task.accountableThreadId === id && inProgress(task.state),
    );
    const node = thread.node as Row | undefined;
    const team = teams.find((row) => node?.type === "subproject" && row.id === node.id);
    const meta =
      role === "ceo"
        ? ["CEO", delegated.length ? waiting(delegated.length) : ""].filter(Boolean).join(" · ")
        : delegated.length
          ? waiting(delegated.length)
          : text(team?.name);
    return { key: id, name: name(thread), role, avatarId: id, threadId: id, meta, tasks: [] };
  };
  const rows: PersonRow[] = [];
  if (ceo) rows.push(managerRow(ceo, "ceo"));
  for (const manager of managers
    .filter((m) => m !== ceo)
    .sort((a, b) => name(a).localeCompare(name(b))))
    rows.push(managerRow(manager, "manager"));

  const byOwner = new Map<string, TaskView[]>();
  for (const task of own)
    if (task.ownerId && active(task))
      byOwner.set(task.ownerId, [...(byOwner.get(task.ownerId) ?? []), task]);
  const order: Record<string, number> = { running: 0, blocked: 1, review: 2, failed: 3, queued: 4 };
  const employees = [...byOwner].map(([ownerId, list]): PersonRow => {
    const sorted = [...list].sort(
      (a, b) =>
        (order[a.state] ?? 9) - (order[b.state] ?? 9) || b.updatedAt.localeCompare(a.updatedAt),
    );
    const only = sorted.length === 1 ? sorted[0] : undefined;
    return {
      key: `employee:${ownerId}`,
      name: sorted[0]?.ownerName || "Agent",
      role: "employee",
      avatarId: ownerId,
      threadId: only?.threadId ?? null,
      meta: only ? taskStateWord(only.state) : workSummary(sorted),
      tasks: only ? [] : sorted,
    };
  });
  return [...rows, ...employees.sort((a, b) => a.name.localeCompare(b.name))];
}

export interface ChatRow {
  threadId: string;
  title: string;
  age: string;
  /** A3: the owner muted this chat. */
  muted: boolean;
}
/** The project's own chats, not task or manager chats, newest first. */
export function drawerChats(
  snapshot: Snapshot,
  projectId: string | null,
  now = Date.now(),
): ChatRow[] {
  if (!projectId) return [];
  const chief = chiefThreadId(snapshot.entities);
  const excluded = new Set([
    ...(snapshot.entities.compare ?? []).map((row) => row.summaryThreadId),
    ...(snapshot.entities.compareMember ?? []).map((row) => row.threadId),
  ]);
  return (snapshot.entities.thread ?? [])
    .filter(
      (thread) =>
        live(thread) &&
        thread.id !== chief &&
        !thread.taskId &&
        thread.kind !== "task" &&
        thread.kind !== "manager" &&
        thread.kind !== "aside" &&
        !excluded.has(thread.id) &&
        threadProject(snapshot, thread) === projectId,
    )
    .sort((a, b) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)))
    .map((thread) => ({
      threadId: text(thread.id),
      title: text(thread.title).trim() || "Chat",
      age: taskAge(text(thread.lastActivityAt), now),
      muted:
        snapshot.entities.settings?.find((row) => row.key === mutedKey(text(thread.id)))?.value ===
        true,
    }));
}

/** Keeps the rows whose name has the query, ignoring case. */
export function matches(query: string, ...names: string[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || names.some((name) => name.toLowerCase().includes(q));
}
