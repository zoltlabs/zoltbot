import { expect, it } from "vitest";
import { handle } from "./commands.js";
import {
  assignCompanyTask,
  cancelCompanyTask,
  companyView,
  decideCompanyPlan,
  dispatchCompanyTask,
  proposeCompanyPlan,
  reviewCompanyTask,
  saveInitiative,
  submitCompanyTask,
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
    thread: [
      {
        id: actor.threadId,
        agentId: actor.agentId,
        kind: "main",
        title: "Chief",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    ],
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

it("lets an IC subdelegate its running approved task while keeping the plan limits", () => {
  let state = fixture();
  state = applyEvents(
    state,
    saveInitiative(state, { ...initiative, managerThreadId: actor.threadId }, ctx).events,
  );
  state = applyEvents(
    state,
    proposeCompanyPlan(
      state,
      actor,
      {
        id: "ic-plan",
        projectId: "co",
        title: "Fix",
        explanation: "Bounded work",
        changes: [
          {
            kind: "initiative",
            value: { ...initiative, managerThreadId: actor.threadId, version: 2 },
            why: "Confirm ownership",
          },
        ],
        authority: {
          initiativeId: "launch",
          maxTasks: 2,
          permissionCeiling: "read_only",
          budgetUsd: 1,
        },
      },
      ctx,
    ).events,
  );
  const plan = state.companyPlan?.[0];
  state = applyEvents(
    state,
    decideCompanyPlan(
      state,
      { id: "ic-plan", version: 1, baseline: String(plan?.baseline), approve: true },
      ctx,
    ).events,
  );
  const agent = { ...ctx, actor: { kind: "agent" as const, id: actor.agentId } };
  state = applyEvents(
    state,
    assignCompanyTask(
      state,
      actor,
      { ...input, id: "parent", initiativeId: "launch", budgetUsd: 0.4 },
      "ic-plan",
      agent,
    ).events,
  );
  state = {
    ...state,
    task: state.task?.map((r) => (r.id === "parent" ? { ...r, state: "running" } : r)) ?? [],
  };
  const ic = { agentId: "worker", threadId: "parent:thread" };
  const child = {
    ...input,
    id: "child",
    initiativeId: "launch",
    parentId: "parent",
    accountableThreadId: ic.threadId,
    budgetUsd: 0.3,
  };
  state = applyEvents(
    state,
    assignCompanyTask(state, ic, child, "ic-plan", {
      ...ctx,
      actor: { kind: "agent", id: "worker" },
    }).events,
  );
  expect(state.task?.find((r) => r.id === "child")).toMatchObject({
    parentId: "parent",
    authorityPlanId: "ic-plan",
  });
  expect(() =>
    assignCompanyTask(state, ic, { ...child, id: "extra" }, "ic-plan", {
      ...ctx,
      actor: { kind: "agent", id: "worker" },
    }),
  ).toThrow("task_limit");
});

it("does not retain a former owner's authority just because it proposed the plan", () => {
  let state = fixture();
  const former = { agentId: "worker", threadId: "former" };
  state.thread?.push({
    ...state.thread[0],
    id: former.threadId,
    agentId: former.agentId,
    kind: "manager",
    projectId: "co",
    node: { type: "project", id: "co" },
  });
  state = applyEvents(
    state,
    saveInitiative(state, { ...initiative, managerThreadId: actor.threadId }, ctx).events,
  );
  state = applyEvents(
    state,
    proposeCompanyPlan(
      state,
      former,
      {
        id: "former-plan",
        projectId: "co",
        title: "Review ownership",
        explanation: "Keep current owner",
        changes: [
          {
            kind: "initiative",
            value: { ...initiative, managerThreadId: actor.threadId, version: 2 },
            why: "Confirm accountability",
          },
        ],
        authority: {
          initiativeId: "launch",
          maxTasks: 2,
          permissionCeiling: "read_only",
          budgetUsd: 1,
        },
      },
      ctx,
    ).events,
  );
  const plan = state.companyPlan?.[0];
  state = applyEvents(
    state,
    decideCompanyPlan(
      state,
      { id: "former-plan", version: 1, baseline: String(plan?.baseline), approve: true },
      ctx,
    ).events,
  );
  expect(() =>
    assignCompanyTask(
      state,
      former,
      { ...input, initiativeId: "launch", budgetUsd: 0.1 },
      "former-plan",
      { ...ctx, actor: { kind: "agent", id: "worker" } },
    ),
  ).toThrow("initiative_owner_required");
});

it("counts plan-created tasks in reservations, dispatches in place, and frees budget on cancel", () => {
  let state = fixture();
  state = applyEvents(
    state,
    saveInitiative(state, { ...initiative, managerThreadId: actor.threadId }, ctx).events,
  );
  const proposed = proposeCompanyPlan(
    state,
    actor,
    {
      id: "plan-vip",
      projectId: "co",
      title: "VIP fix",
      explanation: "Reserve budget and stage planned task",
      changes: [
        {
          kind: "task",
          value: {
            ...input,
            id: "vip-fix",
            initiativeId: "launch",
            planned: true,
            budgetUsd: 0.3,
            acceptance: "Regression test passes",
          },
          why: "Track VIP fix commitment",
        },
      ],
      authority: {
        initiativeId: "launch",
        maxTasks: 2,
        permissionCeiling: "read_only",
        budgetUsd: 0.4,
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
      { id: "plan-vip", version: 1, baseline: String(plan?.baseline), approve: true },
      ctx,
    ).events,
  );
  expect(state.task?.find((r) => r.id === "vip-fix")).toMatchObject({
    planned: true,
    authorityPlanId: "plan-vip",
    budgetUsd: 0.3,
  });
  expect(taskReady(state, state.task?.[0] ?? {})).toBe("Planned work: awaiting dispatch");

  const agentCtx = { ...ctx, actor: { kind: "agent" as const, id: actor.agentId } };
  // Duplicate $0.30 task exceeds $0.40 envelope because plan-created $0.30 task is counted.
  expect(() =>
    assignCompanyTask(
      state,
      actor,
      { ...input, id: "vip-duplicate", initiativeId: "launch", budgetUsd: 0.3 },
      "plan-vip",
      agentCtx,
    ),
  ).toThrow("budget_limit");

  // Dispatching the existing planned task preserves its id, acceptance, and $0.30 reservation.
  state = applyEvents(
    state,
    dispatchCompanyTask(
      state,
      actor,
      { taskId: "vip-fix", brief: "Fix low+vip routing and run tests" },
      agentCtx,
    ).events,
  );
  const dispatched = state.task?.find((r) => r.id === "vip-fix");
  expect(dispatched).toMatchObject({
    id: "vip-fix",
    planned: false,
    acceptance: "Regression test passes",
    brief: "Fix low+vip routing and run tests",
  });
  expect(taskReady(state, dispatched ?? {})).toBeUndefined();

  // Cancelling the task releases its slot and $0.30 reservation so replacement work fits.
  state = applyEvents(
    state,
    cancelCompanyTask(
      state,
      actor,
      { taskId: "vip-fix", reason: "Superseded by narrower fix" },
      agentCtx,
    ).events,
  );
  expect(state.task?.find((r) => r.id === "vip-fix")?.state).toBe("cancelled");
  state = applyEvents(
    state,
    assignCompanyTask(
      state,
      actor,
      { ...input, id: "vip-replacement", initiativeId: "launch", budgetUsd: 0.3 },
      "plan-vip",
      agentCtx,
    ).events,
  );
  expect(state.task?.find((r) => r.id === "vip-replacement")?.state).toBe("queued");
});

it("holds tasks under paused initiatives and failed dependencies, and blocks self-review on direct submit", () => {
  let state = fixture();
  state = applyEvents(
    state,
    saveInitiative(state, { ...initiative, managerThreadId: actor.threadId, state: "paused" }, ctx)
      .events,
  );
  state = applyEvents(
    state,
    assignCompanyTask(
      state,
      undefined,
      { ...input, id: "frozen", initiativeId: "launch" },
      undefined,
      ctx,
    ).events,
  );
  expect(taskReady(state, state.task?.find((r) => r.id === "frozen") ?? {})).toBe(
    "Initiative paused",
  );

  state = applyEvents(
    state,
    saveInitiative(
      state,
      { ...initiative, managerThreadId: actor.threadId, state: "active", version: 2 },
      ctx,
    ).events,
  );
  state = applyEvents(
    state,
    assignCompanyTask(
      state,
      undefined,
      { ...input, id: "downstream", dependencies: ["frozen"], initiativeId: "launch" },
      undefined,
      ctx,
    ).events,
  );
  state = {
    ...state,
    task: state.task?.map((r) => (r.id === "frozen" ? { ...r, state: "failed" } : r)) ?? [],
  };
  expect(taskReady(state, state.task?.find((r) => r.id === "downstream") ?? {})).toBe(
    "Blocked by failed dependency: frozen",
  );

  // Direct execution against a queued commitment records executorThreadId and refuses self-review.
  const planOut = proposeCompanyPlan(
    state,
    actor,
    {
      id: "direct-plan",
      projectId: "co",
      title: "Direct execution",
      explanation: "Allow manager execution with independent review",
      changes: [
        {
          kind: "task",
          value: {
            ...input,
            id: "small-fix",
            initiativeId: "launch",
            planned: true,
            budgetUsd: 0.1,
          },
          why: "Small helper fix",
        },
      ],
      authority: {
        initiativeId: "launch",
        maxTasks: 2,
        reviewTasks: true,
        permissionCeiling: "read_only",
        budgetUsd: 0.5,
      },
    },
    ctx,
  );
  state = applyEvents(state, planOut.events);
  const directPlan = state.companyPlan?.find((r) => r.id === "direct-plan");
  state = applyEvents(
    state,
    decideCompanyPlan(
      state,
      { id: "direct-plan", version: 1, baseline: String(directPlan?.baseline), approve: true },
      ctx,
    ).events,
  );
  const agentCtx = { ...ctx, actor: { kind: "agent" as const, id: actor.agentId } };
  state = applyEvents(
    state,
    submitCompanyTask(
      state,
      actor,
      {
        taskId: "small-fix",
        status: "done",
        summary: "Added isVip helper and ran unit tests",
        files: ["src/router.js", "test/router.test.js"],
      },
      agentCtx,
    ).events,
  );
  expect(state.task?.find((r) => r.id === "small-fix")).toMatchObject({
    state: "review",
    planned: false,
    executorThreadId: actor.threadId,
  });
  expect(state.taskResult?.find((r) => r.taskId === "small-fix")).toMatchObject({
    status: "done",
    auto: false,
    files: ["src/router.js", "test/router.test.js"],
  });
  expect(() =>
    reviewCompanyTask(
      state,
      actor,
      { taskId: "small-fix", revision: 1, decision: "accept", planId: "direct-plan" },
      agentCtx,
    ),
  ).toThrow("independent_reviewer");
});
