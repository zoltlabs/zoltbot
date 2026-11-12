import { text } from "@zoltbot/ui/chat/types";
import { chiefThreadId } from "@zoltbot/ui/chief/data";
import type { Row, Snapshot } from "./transport.js";

export interface DispatchPlace {
  key: string;
  projectId: string;
  node: { type: "project" | "subproject"; id: string };
  label: string;
  fullLabel: string;
}

export interface DispatchGroup {
  projectId: string;
  name: string;
  path: string;
  rootsCount: number;
  /** Single-repo projects with no teams select on one tap instead of opening a sub-list. */
  directSelect: boolean;
  root: DispatchPlace;
  teams: DispatchPlace[];
}

const rows = (snapshot: Snapshot, kind: string): Row[] => snapshot.entities[kind] ?? [];
const live = (row: Row) => row.archived !== true;

/** Active workspaces grouped project-first, with nested teams in tree order beneath each one. */
export function dispatchGroups(snapshot: Snapshot): DispatchGroup[] {
  const projects = rows(snapshot, "project").filter(live);
  const subprojects = rows(snapshot, "subproject").filter(live);
  return projects.map((project) => {
    const projectId = text(project.id);
    const name = text(project.name);
    const roots = Array.isArray(project.roots) ? (project.roots as Row[]) : [];
    const rootsCount = roots.length;
    const firstPath = text(roots[0]?.path || roots[0]?.label);
    const path = rootsCount > 1 && firstPath ? `${firstPath} +${rootsCount - 1}` : firstPath;
    const own = subprojects.filter((row) => text(row.projectId) === projectId);
    const ordered: Row[] = [];
    const visit = (parentId: string | undefined, depth: number) => {
      if (depth > 3) return;
      for (const row of own) {
        const parent = text(row.parentId) || undefined;
        if (parent === parentId) {
          ordered.push(row);
          visit(text(row.id), depth + 1);
        }
      }
    };
    visit(undefined, 1);
    const partsOf = (target: Row) => {
      const names: string[] = [];
      const seen = new Set<string>();
      let current = text(target.id);
      while (current && !seen.has(current) && names.length < 4) {
        seen.add(current);
        const found = own.find((entry) => text(entry.id) === current);
        if (!found) break;
        names.unshift(text(found.name));
        current = text(found.parentId);
      }
      return names;
    };
    const teams: DispatchPlace[] = ordered.map((row) => {
      const id = text(row.id);
      const parts = partsOf(row);
      return {
        key: `subproject:${id}`,
        projectId,
        node: { type: "subproject", id },
        label: parts.join(" › "),
        fullLabel: [name, ...parts].filter(Boolean).join(" › "),
      };
    });
    const root: DispatchPlace = {
      key: `project:${projectId}`,
      projectId,
      node: { type: "project", id: projectId },
      label: name,
      fullLabel: name,
    };
    return {
      projectId,
      name,
      path,
      rootsCount,
      directSelect: teams.length === 0 && rootsCount <= 1,
      root,
      teams,
    };
  });
}

/** Resolves a route `?place=` key or picks the most recently active workspace/team. */
export function resolvePlace(
  snapshot: Snapshot,
  groups: DispatchGroup[],
  param?: string,
): DispatchPlace | undefined {
  if (!groups.length) return undefined;
  const all = groups.flatMap((group) => [group.root, ...group.teams]);
  const byKey = new Map(all.map((place) => [place.key, place]));
  if (param) {
    const exact = byKey.get(param);
    if (exact) return exact;
    const sub = groups.flatMap((group) => group.teams).find((team) => team.node.id === param);
    if (sub) return sub;
    const root = groups.find((group) => group.projectId === param)?.root;
    if (root) return root;
  }
  const chief = chiefThreadId(snapshot.entities);
  let best: { place: DispatchPlace; at: string } | undefined;
  const consider = (row: Row, at: string) => {
    const node = (row.node ?? {}) as Row;
    const key =
      node.type === "project" || node.type === "subproject"
        ? `${node.type}:${text(node.id)}`
        : row.projectId
          ? `project:${text(row.projectId)}`
          : "";
    const place = byKey.get(key);
    if (place && (!best || at > best.at)) best = { place, at };
  };
  for (const task of rows(snapshot, "task").filter(live))
    consider(task, text(task.updatedAt) || text(task.createdAt));
  for (const thread of rows(snapshot, "thread").filter((row) => live(row) && row.id !== chief))
    consider(thread, text(thread.lastActivityAt) || text(thread.createdAt));
  if (best) return best.place;
  const first = groups[0];
  return first ? (first.teams[0] ?? first.root) : undefined;
}

/** Picks the last-used active profile for a scope, falling back to project default, then first profile. */
export function defaultProfileForPlace(
  snapshot: Snapshot,
  place: DispatchPlace | undefined,
): string {
  const available = rows(snapshot, "agent").filter((row) => live(row) && row.hidden !== true);
  const fallback = text(
    (available.find((row) => row.template !== "artifact_designer") ?? available[0])?.id,
  );
  if (!place || !available.length) return fallback;
  const valid = new Set(available.map((row) => text(row.id)));
  const chief = chiefThreadId(snapshot.entities);
  let exactBest: { id: string; at: string } | undefined;
  let projectBest: { id: string; at: string } | undefined;
  const record = (profileId: string, row: Row, at: string) => {
    if (!valid.has(profileId) || text(row.projectId) !== place.projectId) return;
    const node = (row.node ?? {}) as Row;
    const exact = node.type === place.node.type && text(node.id) === place.node.id;
    if (exact && (!exactBest || at > exactBest.at)) exactBest = { id: profileId, at };
    if (!projectBest || at > projectBest.at) projectBest = { id: profileId, at };
  };
  for (const task of rows(snapshot, "task"))
    record(text(task.ownerAgentId), task, text(task.updatedAt) || text(task.createdAt));
  for (const thread of rows(snapshot, "thread"))
    if (thread.id !== chief)
      record(text(thread.agentId), thread, text(thread.lastActivityAt) || text(thread.createdAt));
  if (exactBest) return exactBest.id;
  if (projectBest) return projectBest.id;
  const project = rows(snapshot, "project").find((row) => text(row.id) === place.projectId);
  const configured = text(project?.defaultAgentId);
  if (configured && valid.has(configured)) return configured;
  return fallback;
}

/** Derives a task title from the first non-empty line of a prompt, capped cleanly for task.create. */
export function deriveTaskTitle(prompt: string, max = 80): string {
  const limit = Math.min(150, Math.max(2, max));
  const first =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  if (!first) return "";
  const stripped = first
    .replace(/^(?:#{1,6}|[-*+])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const line = stripped || first.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  const slice = line.slice(0, limit - 1);
  const space = slice.lastIndexOf(" ");
  const cut = space >= Math.floor(limit * 0.5) ? slice.slice(0, space) : slice;
  return `${cut.replace(/[,:;.\s]+$/, "")}…`;
}

/** Tasks and chats directly in a project root or inside one subproject, newest first. */
export function scopeRows(
  snapshot: Snapshot,
  scope: { type: "project" | "subproject"; id: string },
) {
  const chief = chiefThreadId(snapshot.entities);
  const inside = (row: Row) => {
    if (!live(row)) return false;
    const node = (row.node ?? {}) as Row;
    if (scope.type === "subproject")
      return node.type === "subproject" && text(node.id) === scope.id;
    return (
      (node.type === "project" && text(node.id) === scope.id) ||
      (!node.type && text(row.projectId) === scope.id)
    );
  };
  const tasks = rows(snapshot, "task").filter(inside);
  const chats = rows(snapshot, "thread").filter(
    (thread) => inside(thread) && !thread.taskId && thread.id !== chief,
  );
  return [
    ...tasks.map((task) => ({ type: "task" as const, row: task, at: text(task.updatedAt) })),
    ...chats.map((chat) => ({ type: "chat" as const, row: chat, at: text(chat.lastActivityAt) })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}
