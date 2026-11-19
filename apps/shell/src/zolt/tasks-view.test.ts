import { expect, it } from "vitest";
import { toTaskSummaries } from "./tasks-view";

const at = "2026-11-19T10:00:00.000Z";
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  projectId: "p",
  ownerAgentId: "mira",
  threadId: `${id}:thread`,
  state: "queued",
  revision: 1,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

it("lists tasks with their employee, team and a short reason", () => {
  const summaries = toTaskSummaries({
    seq: 1,
    counters: {},
    entities: {
      project: [
        { id: "p", name: "Acme app", archived: false },
        { id: "old", name: "Old", archived: true },
      ],
      subproject: [{ id: "pay", projectId: "p", name: "Payments" }],
      agent: [{ id: "mira", name: "Mira" }],
      thread: [
        { id: "limit:thread", archived: false },
        { id: "deps:thread", archived: true },
      ],
      task: [
        task("limit", { holdReason: "at_limit", node: { type: "subproject", id: "pay" } }),
        task("deps", {
          title: "Refund tests",
          holdReason: "Waiting for accepted dependencies",
          dependencies: ["endpoint"],
        }),
        task("endpoint", { title: "Refund endpoint", state: "running" }),
        task("folder", { holdReason: 'Waiting for "Refund endpoint" to finish in app' }),
        task("failed", { state: "failed", holdReason: "The agent turn failed (rate_limited)" }),
        task("restart", { state: "blocked", holdReason: "daemon_restarted" }),
        task("review", { state: "review", revision: 2 }),
        task("archived", { projectId: "old" }),
      ],
    },
  });
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  expect(byId.has("archived")).toBe(false);
  expect(byId.get("limit")).toMatchObject({
    reason: "at limit",
    atLimit: true,
    owner: { profileId: "mira", name: "Mira" },
    teamId: "pay",
    teamName: "Payments",
    projectName: "Acme app",
    threadId: "limit:thread",
  });
  expect(byId.get("deps")).toMatchObject({
    reason: "waits on Refund endpoint",
    atLimit: false,
    threadId: null,
  });
  expect(byId.get("folder")?.reason).toBe("waits on Refund endpoint");
  expect(byId.get("failed")?.reason).toBe("usage limit");
  expect(byId.get("restart")?.reason).toBe("waiting to resume");
  expect(byId.get("review")).toMatchObject({ reason: "", revision: 2, state: "review" });
  expect(byId.get("endpoint")?.reason).toBe("");
});
