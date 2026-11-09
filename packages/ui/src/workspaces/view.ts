import type { Row } from "../chat/types.js";
import { text } from "../chat/types.js";

export type WorkspaceScope = { type: "project" | "subproject"; id: string };
export const emptyRows: Row[] = [];
export function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
export function atScope(row: Row, scope: WorkspaceScope): boolean {
  const node = object(row.node);
  return node.type === scope.type && node.id === scope.id;
}
export function scopeView(projects: Row[], directions: Row[], scope: WorkspaceScope | undefined) {
  if (!scope) return undefined;
  const chain: Row[] = [],
    seen = new Set<string>();
  let projectId = scope.id;
  if (scope.type === "subproject") {
    let id: string | undefined = scope.id;
    while (id) {
      const row = directions.find((entry) => entry.id === id && !entry.archived);
      if (!row || seen.has(id) || chain.length === 3) return undefined;
      if (chain.length && chain[0]?.projectId !== row.projectId) return undefined;
      seen.add(id);
      chain.unshift(row);
      id = text(row.parentId) || undefined;
    }
    projectId = text(chain[0]?.projectId);
  }
  const project = projects.find((row) => row.id === projectId && !row.archived);
  if (!project) return undefined;
  return { project, directions: chain, current: chain.at(-1) ?? project };
}
