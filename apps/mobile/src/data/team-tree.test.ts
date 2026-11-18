import { expect, it } from "vitest";
import { teamTree } from "./team-tree.js";

it("keeps nested employees and legacy repo chats in scope while excluding Zolt and task chats", () => {
  const result = teamTree({
    seq: 0,
    counters: {},
    entities: {
      settings: [{ key: "chief.thread", value: "zolt" }],
      project: [
        { id: "second", name: "Cicero" },
        { id: "repo", name: "Acme" },
      ],
      subproject: [
        { id: "project", projectId: "repo", name: "Launch" },
        { id: "nested", projectId: "repo", parentId: "project", name: "QA" },
        { id: "archived", projectId: "repo", parentId: "project", archived: true },
      ],
      thread: [
        { id: "zolt", kind: "main" },
        { id: "legacy", projectId: "repo" },
        { id: "lead", kind: "manager", node: { type: "subproject", id: "project" } },
        { id: "qa", node: { type: "subproject", id: "nested" } },
        { id: "task", kind: "task", node: { type: "subproject", id: "nested" } },
        { id: "compare", node: { type: "subproject", id: "nested" } },
        { id: "archived-chat", archived: true, node: { type: "subproject", id: "nested" } },
      ],
      compareMember: [{ threadId: "compare" }],
      turn: [{ threadId: "qa", status: "running" }],
    },
  });
  expect(result.map((repo) => repo.name)).toEqual(["Acme", "Cicero"]);
  expect(result[0]?.employees.map(({ thread }) => thread.id)).toEqual(["legacy"]);
  const project = result[0]?.projects[0];
  expect(project?.employees.map(({ thread }) => thread.id)).toEqual(["lead"]);
  expect(project?.projects.map(({ id }) => id)).toEqual(["nested"]);
  expect(project?.projects[0]?.employees).toMatchObject([{ thread: { id: "qa" }, working: true }]);
});
