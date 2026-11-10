import { expect, it } from "vitest";
import { handle } from "./commands.js";
import {
  assignCompanyTask,
  companyView,
  decideCompanyPlan,
  proposeCompanyPlan,
  reviewCompanyTask,
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
    settings: [{ key: "chief.thread", value: actor.threadId }],
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

it("delegates task review only when explicitly approved and never to the executing chat", () => {
  let state = fixture();
  state = applyEvents(
    state,
    saveInitiative(state, { ...initiative, managerThreadId: actor.threadId }, ctx).events,
  );
  const proposed = proposeCompanyPlan(
    state,
    actor,
    {
      id: "review-plan",
      projectId: "co",
      title: "Delegate review",
      explanation: "Coordinate acceptance",
      changes: [
        {
          kind: "task",
          value: { ...input, id: "work", initiativeId: "launch", planned: true },
          why: "Deliver the fix",
        },
      ],
      authority: {
        initiativeId: "launch",
        maxTasks: 2,
        reviewTasks: true,
        permissionCeiling: "read_only",
        budgetUsd: 1,
      },
    },
    ctx,
  );
  state = applyEvents(state, proposed.events);
  const plan = state.companyPlan?.[0];
  state = applyEvents(
    state,
    decideCompanyPlan(
      state,
      { id: "review-plan", version: 1, baseline: String(plan?.baseline), approve: true },
      ctx,
    ).events,
  );
  state = {
    ...state,
    task: state.task?.map((r) => (r.id === "work" ? { ...r, state: "review" } : r)) ?? [],
  };
  const agent = { ...ctx, actor: { kind: "agent" as const, id: actor.agentId } };
  expect(() =>
    reviewCompanyTask(state, actor, { taskId: "work", revision: 1, decision: "accept" }, agent),
  ).toThrow("review_authority");
  const accepted = reviewCompanyTask(
    state,
    actor,
    { taskId: "work", revision: 1, decision: "accept", planId: "review-plan" },
    agent,
  );
  expect(accepted.result.state).toBe("completed");
  expect(() =>
    reviewCompanyTask(
      state,
      { ...actor, threadId: "work:thread" },
      { taskId: "work", revision: 1, decision: "accept", planId: "review-plan" },
      agent,
    ),
  ).toThrow("independent_reviewer");
});

it("rejects hierarchy cycles, out-of-workspace moves and invalid later changes without mutating state", () => {
  const state = fixture();
  const original = JSON.stringify(state);
  const changes = [
    {
      kind: "team" as const,
      id: "eng",
      name: "Engineering",
      parent: { type: "project" as const, id: "co" },
      why: "Own implementation",
    },
    {
      kind: "moveTeam" as const,
      id: "eng",
      parent: { type: "subproject" as const, id: "eng" },
      why: "Invalid self move",
    },
  ];
  expect(() =>
    proposeCompanyPlan(
      state,
      actor,
      { id: "cycle", projectId: "co", title: "Bad move", explanation: "Test rollback", changes },
      ctx,
    ),
  ).toThrow("team_cycle");
  expect(JSON.stringify(state)).toBe(original);
  expect(() =>
    proposeCompanyPlan(
      state,
      actor,
      {
        id: "cross",
        projectId: "co",
        title: "Bad scope",
        explanation: "Test isolation",
        changes: [
          {
            kind: "team",
            id: "other",
            name: "Other",
            parent: { type: "project", id: "missing" },
            why: "Invalid destination",
          },
        ],
      },
      ctx,
    ),
  ).toThrow("scope_unavailable");
});
