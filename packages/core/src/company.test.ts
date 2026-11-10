import { expect, it } from "vitest";
import { handle } from "./commands.js";
import {
  assignCompanyTask,
  companyView,
  decideCompanyPlan,
  proposeCompanyPlan,
  saveInitiative,
  writeProjectBrief,
} from "./company.js";
import { companyBaseline } from "./company-changes.js";
import { applyEvents, type DomainState } from "./projectors.js";
import {
  requireChildrenAccepted,
  taskProgress,
  taskReady,
  validateTaskGraph,
} from "./task-graph.js";

const at = "2026-11-09T12:00:00Z";
const ctx = { commandId: "test", at, actor: { kind: "human" as const, id: "owner" } };
const actor = { agentId: "chief", threadId: "chief-chat" };
function fixture(): DomainState {
  return {
    project: [
      {
        id: "co",
        name: "Example",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth: 0,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      },
    ],
    agent: [
      {
        id: "chief",
        kind: "chief_of_staff",
        archived: false,
        permissionProfile: "workspace_write",
      },
      { id: "worker", archived: false, permissionProfile: "read_only" },
    ],
    thread: [{ id: actor.threadId, agentId: actor.agentId, archived: false }],
  };
}
const initiative = {
  id: "launch",
  projectId: "co",
  title: "Launch",
  outcome: "Ship",
  acceptance: "Verified",
  priority: "high" as const,
  state: "active" as const,
  constraints: "",
  knowledgeIds: [],
  version: 1,
  createdAt: at,
  updatedAt: at,
};
const input = {
  id: "fix",
  title: "Fix a bug",
  brief: "Fix the issue",
  profileId: "worker",
  node: { type: "project" as const, id: "co" },
};
it("supports a direct task without an initiative or manager", () => {
  const state = applyEvents(
    fixture(),
    assignCompanyTask(fixture(), undefined, input, undefined, ctx).events,
  );
  expect(state.task?.[0]).toMatchObject({ id: "fix", state: "queued" });
  expect(state.thread?.find((r) => r.id === "fix:thread")).toMatchObject({ kind: "task" });
});
it("keeps initiative lifecycle independent of teams and requires accepted work", () => {
  let state = fixture();
  state = applyEvents(state, saveInitiative(state, initiative, ctx).events);
  state = applyEvents(
    state,
    assignCompanyTask(state, undefined, { ...input, initiativeId: "launch" }, undefined, ctx)
      .events,
  );
  expect(() =>
    saveInitiative(state, { ...initiative, version: 2, state: "completed" }, ctx),
  ).toThrow("open_work");
  expect(companyView(state, "co").initiatives[0]?.progress).toMatchObject({
    accepted: 0,
    total: 1,
  });
});
it("binds approval to a dry-run preview and rejects changed state", () => {
  let state = fixture();
  const proposal = proposeCompanyPlan(
    state,
    actor,
    {
      id: "p",
      projectId: "co",
      title: "Organize",
      explanation: "Launch",
      changes: [
        {
          kind: "team",
          id: "eng",
          name: "Engineering",
          parent: { type: "project", id: "co" },
          why: "Own delivery",
        },
        { kind: "initiative", value: initiative, why: "Track launch" },
      ],
    },
    ctx,
  );
  state = applyEvents(state, proposal.events);
  expect(state.subproject).toBeUndefined();
  const plan = state.companyPlan?.[0];
  expect(plan?.preview).toHaveLength(2);
  const decision = { id: "p", version: 1, baseline: String(plan?.baseline), approve: true };
  const changed = applyEvents(
    state,
    handle(state, { type: "update", kind: "project", id: "co", changes: { goal: "Changed" } }, ctx)
      .events,
  );
  expect(() => decideCompanyPlan(changed, decision, ctx)).toThrow("stale_plan");
  const approved = applyEvents(state, decideCompanyPlan(state, decision, ctx).events);
  expect(approved.subproject?.[0]?.name).toBe("Engineering");
  expect(approved.companyPlan?.[0]?.state).toBe("applied");
  expect(() => decideCompanyPlan(approved, decision, ctx)).toThrow("stale_plan");
});
it("checks combined dependency and parent cycles and accepted rollups", () => {
  const parent = { id: "p", projectId: "co", state: "review" };
  const child = { id: "c", projectId: "co", parentId: "p", dependencies: ["p"], state: "review" };
  expect(() => validateTaskGraph({ task: [parent] }, child)).toThrow("cycle");
  const state = { task: [parent, { ...child, dependencies: [] }] };
  expect(() => requireChildrenAccepted(state, "p")).toThrow("incomplete_children");
  expect(taskProgress(state, state.task)).toMatchObject({ total: 1, finished: 1, accepted: 0 });
  expect(taskReady(state, { dependencies: ["c"] })).toContain("accepted");
});
it("records dated report revisions and preserves evidence", () => {
  let state = fixture();
  state = applyEvents(state, writeProjectBrief(state, "co", "No commitments yet", ctx).events);
  state = applyEvents(state, writeProjectBrief(state, "co", "Updated direction", ctx).events);
  expect(state.projectBrief).toHaveLength(2);
  expect(state.projectBrief?.[1]?.revision).toBe(2);
  expect(companyBaseline(state, "co")).toBe(companyBaseline(fixture(), "co"));
});
