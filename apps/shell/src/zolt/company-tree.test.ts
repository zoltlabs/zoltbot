import { expect, it } from "vitest";
import { companyTree } from "./company-tree";

const at = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`;
const thread = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  title: id,
  pinned: false,
  archived: false,
  lastActivityAt: at(1),
  ...extra,
});

it("orders each project as CEO, managers and their employees, then loose chats", () => {
  const { entries, projects } = companyTree({
    seq: 1,
    counters: {},
    entities: {
      settings: [{ key: "chief.thread", value: "chief" }],
      project: [{ id: "p", name: "Launch", roots: [{ path: "/work/launch" }], archived: false }],
      subproject: [
        { id: "web", projectId: "p", name: "Web" },
        { id: "docs", projectId: "p", parentId: "web", name: "Docs" },
      ],
      task: [
        { id: "t1", projectId: "p", accountableThreadId: "web-lead" },
        { id: "t2", projectId: "p", node: { type: "subproject", id: "docs" } },
        { id: "t3", projectId: "p" },
      ],
      thread: [
        thread("chief", "main", { lastActivityAt: at(0) }),
        thread("ceo", "manager", { projectId: "p", node: { type: "project", id: "p" } }),
        thread("web-lead", "manager", { projectId: "p", node: { type: "subproject", id: "web" } }),
        thread("docs-lead", "manager", { node: { type: "subproject", id: "docs" } }),
        thread("build", "task", { taskId: "t1", projectId: "p" }),
        thread("write", "task", { taskId: "t2" }),
        thread("triage", "task", { taskId: "t3", projectId: "p" }),
        thread("notes", "side", { projectId: "p" }),
        thread("old", "task", { taskId: "t1", archived: true }),
        thread("scratch", "main", { lastActivityAt: at(5) }),
      ],
    },
  });
  expect(projects).toEqual([{ id: "p", name: "Launch", path: "/work/launch" }]);
  expect(entries.map((e) => [e.thread.id, e.role, e.depth, e.parentId, e.projectId])).toEqual([
    ["chief", "chief", 0, null, null],
    ["ceo", "ceo", 0, null, "p"],
    ["web-lead", "manager", 1, "ceo", "p"],
    ["docs-lead", "manager", 2, "web-lead", "p"],
    ["write", "employee", 3, "docs-lead", "p"],
    ["build", "employee", 2, "web-lead", "p"],
    ["triage", "employee", 1, "ceo", "p"],
    ["notes", "chat", 0, null, "p"],
    ["scratch", "chat", 0, null, null],
  ]);
});
