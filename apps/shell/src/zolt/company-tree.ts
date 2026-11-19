import type { Row, Snapshot } from "./daemon-client";

export type CompanyRole = "chief" | "ceo" | "manager" | "employee" | "chat";

export interface TreeEntry {
  thread: Row;
  depth: number;
  role: CompanyRole;
  parentId: string | null;
  projectId: string | null;
}

export interface TreeProject {
  id: string;
  name: string;
  path: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const recent = (a: Row, b: Row) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt));
const byPin = (a: Row, b: Row) =>
  a.pinned !== b.pinned ? (a.pinned === true ? -1 : 1) : recent(a, b);

/**
 * Orders the chats the sidebar shows as each project's company: its CEO (the manager for the
 * whole project), the team managers under it, and the employees (task chats) each manager is
 * accountable for. Chats outside any project come last.
 */
export function companyTree(snapshot: Snapshot): { entries: TreeEntry[]; projects: TreeProject[] } {
  const entities = snapshot.entities;
  const threads = (entities.thread ?? []).filter(
    (thread) =>
      thread.archived !== true && ["main", "manager", "side", "task"].includes(text(thread.kind)),
  );
  const projects = (entities.project ?? [])
    .filter((project) => project.archived !== true)
    .map((project) => ({
      id: text(project.id),
      name: text(project.name) || "Project",
      path: text(((project.roots as Row[] | undefined) ?? [])[0]?.path),
    }));
  const projectIds = new Set(projects.map((project) => project.id));
  const teams = new Map((entities.subproject ?? []).map((team) => [text(team.id), team]));
  const tasks = new Map((entities.task ?? []).map((task) => [text(task.id), task]));
  const projectOf = (thread: Row): string | null => {
    const direct = text(thread.projectId);
    if (projectIds.has(direct)) return direct;
    const node = thread.node as Row | undefined;
    if (node?.type === "project" && projectIds.has(text(node.id))) return text(node.id);
    if (node?.type === "subproject") {
      const team = teams.get(text(node.id));
      if (team && projectIds.has(text(team.projectId))) return text(team.projectId);
    }
    const task = tasks.get(text(thread.taskId));
    if (task && projectIds.has(text(task.projectId))) return text(task.projectId);
    return null;
  };

  const entries: TreeEntry[] = [];
  const placed = new Set<string>();
  const children = new Map<string, Row[]>();
  const roles = new Map<string, CompanyRole>();
  const add = (thread: Row, depth: number, role: CompanyRole, parentId: string | null) => {
    const id = text(thread.id);
    if (placed.has(id)) return;
    placed.add(id);
    entries.push({ thread, depth, role, parentId, projectId: projectOf(thread) });
    for (const child of (children.get(id) ?? []).sort(byPin))
      add(child, depth + 1, roles.get(text(child.id)) ?? "employee", id);
  };

  // The chief is the chat the daemon names in the chief.thread setting.
  const chiefId = (entities.settings ?? []).find((row) => row.key === "chief.thread")?.value;
  const chief = threads.find((t) => t.id === chiefId && !projectOf(t) && !t.taskId);
  if (chief) add(chief, 0, "chief", null);

  for (const project of projects) {
    const own = threads.filter((thread) => projectOf(thread) === project.id);
    const managers = own.filter((thread) => thread.kind === "manager");
    const ceo =
      managers.find((m) => (m.node as Row | undefined)?.type === "project") ??
      managers.find((m) => !(m.node as Row | undefined)?.type);
    const managerFor = new Map<string, string>();
    for (const manager of managers) {
      const node = manager.node as Row | undefined;
      if (node?.type === "subproject") managerFor.set(text(node.id), text(manager.id));
    }
    const teamManager = (teamId: string): string | undefined => {
      for (let id: string | undefined = teamId; id; id = text(teams.get(id)?.parentId) || undefined)
        if (managerFor.has(id)) return managerFor.get(id);
      return undefined;
    };
    const parentOf = (thread: Row): string | undefined => {
      const id = text(thread.id);
      if (thread.kind === "manager") {
        if (thread === ceo) return undefined;
        const node = thread.node as Row | undefined;
        const team = teams.get(text(node?.id));
        const above = team?.parentId ? teamManager(text(team.parentId)) : undefined;
        return above && above !== id ? above : ceo ? text(ceo.id) : undefined;
      }
      if (thread.kind !== "task") return undefined;
      const task = tasks.get(text(thread.taskId));
      const accountable = text(task?.accountableThreadId);
      if (accountable && managers.some((m) => m.id === accountable) && accountable !== id)
        return accountable;
      const node = (task?.node ?? thread.node) as Row | undefined;
      if (node?.type === "subproject") {
        const manager = teamManager(text(node.id));
        if (manager) return manager;
      }
      return ceo ? text(ceo.id) : undefined;
    };
    for (const thread of own) {
      roles.set(text(thread.id), thread.kind === "manager" ? "manager" : "employee");
      const parent = parentOf(thread);
      if (parent) children.set(parent, [...(children.get(parent) ?? []), thread]);
    }
    if (ceo) add(ceo, 0, "ceo", null);
    for (const manager of managers.filter((m) => !parentOf(m)).sort(byPin))
      add(manager, 0, "manager", null);
    for (const thread of own.filter((t) => t.kind === "task" && !parentOf(t)).sort(byPin))
      add(thread, 0, "employee", null);
    for (const thread of own.filter((t) => t.kind === "main" || t.kind === "side").sort(byPin))
      add(thread, 0, "chat", null);
  }

  for (const thread of threads.filter((t) => !placed.has(text(t.id))).sort(byPin))
    if (thread.kind !== "task") add(thread, 0, "chat", null);
  return { entries, projects };
}
