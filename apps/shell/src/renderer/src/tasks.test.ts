import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../../shared/tasks";
import type { BotProfile } from "./data";
import {
  employeeSummary,
  groupTasks,
  needsYouCount,
  sidebarEntries,
  stableEntries,
  statusLabel,
  taskAge,
  withPendingReviews,
} from "./tasks";

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  projectId: "p",
  projectName: "Acme app",
  state: "running",
  revision: 1,
  reason: "",
  atLimit: false,
  threadId: `${id}:thread`,
  owner: { profileId: "mira", name: "Mira" },
  teamId: null,
  teamName: "",
  document: null,
  createdAt: "2026-11-19T10:00:00.000Z",
  updatedAt: "2026-11-19T10:00:00.000Z",
  ...extra,
});

const bot = (id: string, extra: Partial<BotProfile> = {}) =>
  ({
    id,
    name: id,
    role: "Mira",
    kind: "task",
    projectId: "p",
    parentId: "manager",
    depth: 1,
    ...extra,
  }) as BotProfile;

describe("task helpers", () => {
  it("groups tasks into Needs you, Running, Queued and Done", () => {
    const groups = groupTasks([
      task("review", { state: "review", updatedAt: "2026-11-19T10:05:00.000Z" }),
      task("failed", { state: "failed", updatedAt: "2026-11-19T10:09:00.000Z" }),
      task("running"),
      task("blocked", { state: "blocked" }),
      task("later", { state: "queued", createdAt: "2026-11-19T10:02:00.000Z" }),
      task("sooner", { state: "queued", createdAt: "2026-11-19T10:01:00.000Z" }),
      task("accepted", { state: "completed" }),
      task("stopped", { state: "cancelled" }),
    ]);
    expect(groups.needs_you.map((row) => row.id)).toEqual(["failed", "review"]);
    expect(groups.running.map((row) => row.id)).toEqual(["blocked", "running"]);
    expect(groups.queued.map((row) => row.id)).toEqual(["sooner", "later"]);
    expect(groups.done.map((row) => row.id)).toEqual(["accepted", "stopped"]);
    expect(needsYouCount(Object.values(groups).flat())).toBe(2);
  });

  it("labels status with its reason and ages tasks", () => {
    expect(statusLabel(task("a", { state: "queued", reason: "at limit" }))).toBe(
      "Queued · at limit",
    );
    expect(statusLabel(task("b", { state: "review" }))).toBe("Ready for review");
    const now = Date.parse("2026-11-19T10:00:00.000Z");
    expect(taskAge("2026-11-19T10:00:00.000Z", now + 20_000)).toBe("now");
    expect(taskAge("2026-11-19T10:00:00.000Z", now + 4 * 60_000)).toBe("4m");
    expect(taskAge("2026-11-19T10:00:00.000Z", now + 3 * 3_600_000)).toBe("3h");
    expect(taskAge("2026-11-19T10:00:00.000Z", now + 49 * 3_600_000)).toBe("2d");
  });

  it("shows a review as decided until the daemon reports the new state", () => {
    const review = task("r", { state: "review", revision: 2 });
    expect(withPendingReviews([review], { r: { revision: 2, state: "completed" } })[0]?.state).toBe(
      "completed",
    );
    expect(withPendingReviews([review], { r: { revision: 1, state: "completed" } })[0]).toBe(
      review,
    );
  });
});

describe("sidebar employees", () => {
  const bots = [
    bot("manager", { kind: "manager", role: "Lead", parentId: null, depth: 0 }),
    bot("a"),
    bot("theo", { role: "Theo" }),
    bot("b"),
    bot("c"),
    bot("done"),
  ];
  const tasks = [
    task("a", { threadId: "a" }),
    task("b", { threadId: "b" }),
    task("c", { threadId: "c", state: "queued" }),
    task("theo", { threadId: "theo", owner: { profileId: "theo", name: "Theo" } }),
    task("done", { threadId: "done", state: "completed" }),
  ];

  it("collapses an employee with several tasks in progress into one row", () => {
    const entries = sidebarEntries(bots, tasks);
    expect(
      entries.map((entry) => (entry.kind === "bot" ? entry.bot.id : entry.employee.name)),
    ).toEqual(["manager", "Mira", "theo", "done"]);
    const employee = entries.find((entry) => entry.kind === "employee");
    if (employee?.kind !== "employee") throw new Error("expected an employee row");
    expect(employee.employee.bots.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(employeeSummary(employee.employee)).toBe("2 running · 1 queued");
  });

  it("keeps a single task chat as its own row", () => {
    const entries = sidebarEntries(bots, [task("a", { threadId: "a" })]);
    expect(entries.every((entry) => entry.kind === "bot")).toBe(true);
  });

  it("reuses entry objects while they show the same thing", () => {
    const stable = stableEntries();
    const first = stable(sidebarEntries(bots, tasks));
    const second = stable(
      sidebarEntries(
        bots,
        tasks.map((row) => ({ ...row })),
      ),
    );
    expect(second).toEqual(first);
    for (const [index, entry] of second.entries()) expect(entry).toBe(first[index]);
    const changed = stable(
      sidebarEntries(
        bots,
        tasks.map((row) => (row.id === "c" ? { ...row, state: "running" as const } : row)),
      ),
    );
    expect(changed[1]).not.toBe(first[1]);
    expect(changed[0]).toBe(first[0]);
  });
});
