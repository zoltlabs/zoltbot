import { expect, it } from "vitest";
import { currentResult, groupTasks, holdText, placeName } from "./view.js";

it("groups tasks by what they need from the human", () => {
  const groups = groupTasks([
    { id: "a", state: "review", updatedAt: "2026-11-02T10:00:00Z" },
    { id: "b", state: "failed", updatedAt: "2026-11-02T11:00:00Z" },
    { id: "c", state: "queued", createdAt: "2026-11-02T09:00:00Z" },
    { id: "d", state: "queued", createdAt: "2026-11-02T08:00:00Z" },
    { id: "e", state: "blocked", updatedAt: "2026-11-02T08:00:00Z" },
    { id: "f", state: "cancelled", updatedAt: "2026-11-02T08:00:00Z" },
  ]);
  expect(groups.needs_you.map((row) => row.id)).toEqual(["b", "a"]);
  expect(groups.queued.map((row) => row.id)).toEqual(["d", "c"]);
  expect(groups.running.map((row) => row.id)).toEqual(["e"]);
  expect(groups.done.map((row) => row.id)).toEqual(["f"]);
});

it("finds the result for the current revision and names the task's place", () => {
  const results = [
    { taskId: "a", revision: 1, summary: "old" },
    { taskId: "a", revision: 2, summary: "new" },
  ];
  expect(currentResult({ id: "a", revision: 2 }, results)?.summary).toBe("new");
  expect(currentResult({ id: "a", revision: 3 }, results)).toBeUndefined();
  expect(
    placeName(
      { projectId: "zolt", node: { type: "subproject", id: "food" } },
      [{ id: "zolt", name: "Zolt" }],
      [
        { id: "product", name: "Product" },
        { id: "food", name: "Food logging", parentId: "product" },
      ],
    ),
  ).toBe("Zolt / Product / Food logging");
  expect(holdText({ holdReason: "daemon_restarted" })).toContain("restarted");
  expect(holdText({ holdReason: 'Waiting for "A" to finish in code' })).toBe(
    'Waiting for "A" to finish in code',
  );
  expect(holdText({ holdReason: "The agent turn failed (runtime_open_failed)" })).toBe(
    "The coding tool could not start. Check it in Settings › Coding agents.",
  );
  expect(holdText({ holdReason: "The agent turn failed (something_new)" })).not.toContain(
    "something_new",
  );
});
