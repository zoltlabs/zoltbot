import type { Row, Snapshot } from "./transport.js";
import { chats, text } from "./view.js";

type Employee = ReturnType<typeof chats>[number];
export type TeamNode = {
  id: string;
  name: string;
  projects: TeamNode[];
  employees: Employee[];
};

export function teamTree(snapshot: Snapshot): TeamNode[] {
  const { project = [], subproject = [], compare = [], compareMember = [] } = snapshot.entities;
  const excluded = new Set([
    ...compare.map((group) => group.summaryThreadId),
    ...compareMember.map((member) => member.threadId),
  ]);
  const employees = chats(snapshot).filter(
    ({ thread, chief }) =>
      !chief && thread.kind !== "task" && !thread.taskId && !excluded.has(thread.id),
  );
  const named = (a: Row, b: Row) => text(a.name).localeCompare(text(b.name));
  return project
    .filter((repo) => !repo.archived)
    .sort(named)
    .map((repo) => {
      const projectId = text(repo.id);
      const children = subproject
        .filter((row) => row.projectId === projectId && !row.archived)
        .sort(named);
      const build = (row: Row, depth: number): TeamNode => {
        const id = text(row.id);
        return {
          id,
          name: text(row.name),
          projects:
            depth === 3
              ? []
              : children
                  .filter((child) => child.parentId === id)
                  .map((child) => build(child, depth + 1)),
          employees: employees.filter(({ thread }) => {
            const node = thread.node as Row | undefined;
            return node?.type === "subproject" && node.id === id;
          }),
        };
      };
      return {
        id: projectId,
        name: text(repo.name),
        projects: children.filter((row) => !row.parentId).map((row) => build(row, 1)),
        employees: employees.filter(({ thread }) => {
          const node = thread.node as Row | undefined;
          return (
            (node?.type === "project" && node.id === projectId) ||
            (thread.projectId === projectId && (!node || node.type === "user"))
          );
        }),
      };
    });
}
