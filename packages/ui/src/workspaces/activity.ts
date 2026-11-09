import { type Row, text } from "../chat/types.js";
import { object } from "./view.js";

export type ChatStatus = "needs_you" | "working" | "done" | "idle";
export const statusRank: Record<ChatStatus, number> = {
  needs_you: 0,
  working: 1,
  done: 2,
  idle: 3,
};
const open = new Set(["starting", "ready", "running"]);

// A rolling window, so work that finished late last night still shows the next morning.
const recentMs = 24 * 60 * 60_000;
export function recent(at: unknown, now: Date) {
  const age = now.getTime() - new Date(text(at)).getTime();
  return age >= 0 && age < recentMs;
}

/** One status per thread: a pending request wins, then a running turn, then a turn that finished in the last day. */
export function chatStatuses(entities: Record<string, Row[] | undefined>, now = new Date()) {
  const needs = new Set<string>(),
    working = new Set<string>(),
    latest = new Map<string, Row>();
  for (const row of entities.interaction ?? [])
    if (row.state === "pending") needs.add(text(row.threadId));
  for (const row of entities.turn ?? []) {
    const id = text(row.threadId);
    if (row.status === "running") working.add(id);
    const previous = latest.get(id);
    if (!previous || text(row.startedAt) > text(previous.startedAt)) latest.set(id, row);
  }
  const result = new Map<string, ChatStatus>();
  for (const thread of entities.thread ?? []) {
    const id = text(thread.id),
      turn = latest.get(id);
    result.set(
      id,
      needs.has(id)
        ? "needs_you"
        : working.has(id)
          ? "working"
          : turn?.status === "completed" && recent(turn.endedAt, now)
            ? "done"
            : "idle",
    );
  }
  return result;
}

/** "Workspace › Team › Sub-team" for a thread, or "" when it is not in a project. */
export function scopeLabel(thread: Row, projects: Row[], directions: Row[]) {
  const node = object(thread.node),
    names: string[] = [],
    seen = new Set<string>();
  let projectId = text(thread.projectId);
  if (node.type === "subproject") {
    let id = text(node.id);
    while (id && !seen.has(id) && names.length < 3) {
      seen.add(id);
      const row = directions.find((entry) => entry.id === id);
      if (!row) break;
      names.unshift(text(row.name));
      projectId = text(row.projectId);
      id = text(row.parentId);
    }
  } else if (node.type === "project") projectId = text(node.id);
  const project = projects.find((row) => row.id === projectId);
  return [project ? text(project.name) : "", ...names].filter(Boolean).join(" › ");
}

/** Folders that two or more chats have open sessions in, so their changes can collide. */
export function sharedFolders(sessions: Row[]) {
  const byFolder = new Map<string, Set<string>>();
  for (const row of sessions) {
    const cwd = text(row.cwd);
    if (!cwd || !open.has(text(row.state))) continue;
    const threads = byFolder.get(cwd) ?? new Set<string>();
    threads.add(text(row.threadId));
    byFolder.set(cwd, threads);
  }
  return [...byFolder]
    .filter(([, threads]) => threads.size > 1)
    .map(([cwd, threads]) => ({ cwd, threadIds: [...threads].sort() }));
}

/** The provider of a thread's newest session, for the Claude and Codex labels. */
export function threadProvider(sessions: Row[], threadId: string) {
  let newest: Row | undefined;
  for (const row of sessions)
    if (row.threadId === threadId && (!newest || text(row.startedAt) > text(newest.startedAt)))
      newest = row;
  return text(newest?.provider);
}

export function ago(at: unknown, now = new Date()) {
  const ms = now.getTime() - new Date(text(at)).getTime();
  if (Number.isNaN(ms)) return "";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The workspace a thread belongs to, through its team when it is in one. */
export function threadProject(thread: Row, directions: Row[]) {
  const node = object(thread.node);
  if (node.type === "project") return text(node.id);
  if (node.type === "subproject")
    return text(directions.find((row) => row.id === node.id)?.projectId) || text(thread.projectId);
  return text(thread.projectId);
}

/**
 * The workspace to open at launch: the one whose chats were active most recently, else the newest.
 * Archived workspaces never qualify.
 */
export function mostRecentProject(projects: Row[], threads: Row[], directions: Row[]) {
  const latest = new Map<string, string>();
  for (const thread of threads) {
    const id = threadProject(thread, directions),
      at = text(thread.lastActivityAt) || text(thread.createdAt);
    if (id && at > (latest.get(id) ?? "")) latest.set(id, at);
  }
  let best: Row | undefined,
    bestAt = "";
  for (const project of projects) {
    if (project.archived) continue;
    const at = latest.get(text(project.id)) ?? text(project.createdAt);
    if (!best || at > bestAt) [best, bestAt] = [project, at];
  }
  return best;
}

/** What a chat row says at a glance, T3-style: the one thing most worth your attention. */
export type RowStatus = "approval" | "input" | "working" | "failed" | "done" | "idle";
export const rowStatusLabels: Record<RowStatus, string> = {
  approval: "Approval",
  input: "Input",
  working: "Working",
  failed: "Failed",
  done: "Done",
  idle: "",
};

/**
 * An approval waits on you first, then a question, then running work. A finished or failed turn
 * shows only until the chat is opened after it ended; `seen` holds those times per chat.
 */
export function rowStatuses(
  entities: Record<string, Row[] | undefined>,
  seen: Record<string, string>,
) {
  const asks = new Map<string, RowStatus>(),
    working = new Set<string>(),
    latest = new Map<string, Row>();
  for (const row of entities.interaction ?? []) {
    if (row.state !== "pending") continue;
    const id = text(row.threadId),
      kind: RowStatus = row.type === "approval" || row.type === "gate" ? "approval" : "input";
    if (asks.get(id) !== "approval") asks.set(id, kind);
  }
  for (const row of entities.turn ?? []) {
    const id = text(row.threadId);
    if (row.status === "running") working.add(id);
    const previous = latest.get(id);
    if (!previous || text(row.startedAt) > text(previous.startedAt)) latest.set(id, row);
  }
  const result = new Map<string, RowStatus>();
  for (const thread of entities.thread ?? []) {
    const id = text(thread.id),
      turn = latest.get(id),
      unseen = !!turn && text(turn.endedAt) > (seen[id] ?? "");
    result.set(
      id,
      asks.get(id) ??
        (working.has(id)
          ? "working"
          : unseen && turn?.status === "failed"
            ? "failed"
            : unseen && turn?.status === "completed"
              ? "done"
              : "idle"),
    );
  }
  return result;
}
