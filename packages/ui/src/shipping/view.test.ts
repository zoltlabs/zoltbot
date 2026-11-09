import type { Shipping } from "@zoltbot/protocol";
import { expect, test } from "vitest";
import { groupTasks } from "../tasks/view.js";
import { attention, safeLink, shippingError, summary } from "./view.js";

test("GitHub attention does not change acceptance and can include older completed tasks", () => {
  const tasks = Array.from({ length: 25 }, (_, n) => ({
    id: `task${n}`,
    state: "completed",
    createdAt: String(n),
    updatedAt: String(n),
  }));
  expect(groupTasks(tasks).done).toHaveLength(20);
  expect(groupTasks(tasks, true).done).toHaveLength(25);
  const row = {
    snapshot: {
      number: 42,
      state: "OPEN",
      draft: true,
      mergeState: "BLOCKED",
      reviewDecision: "UNKNOWN",
      checks: [{ state: "FAILURE" }],
      threads: [],
    },
  } as unknown as Shipping;
  expect(attention(row)).toBe(true);
  expect(summary(row)).toContain("1 check failing");
  if (row.snapshot) row.snapshot.state = "MERGED";
  expect(attention(row)).toBe(false);
});
test("remote links and errors do not expose unsafe destinations or raw process output", () => {
  expect(safeLink("javascript:alert(1)")).toBeUndefined();
  expect(safeLink("https://token@example.test")).toBeUndefined();
  expect(shippingError(new Error("github_request_failed: raw-secret"))).not.toContain("raw-secret");
});
