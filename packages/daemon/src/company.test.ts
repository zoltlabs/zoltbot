import { finishTaskTurn, handle, startTask } from "@zoltbot/core";
import type { CompanyPlan, InitiativeRecord } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { chiefFixture } from "./chief/test-fixture.js";
import { companyApi } from "./company-api.js";
import { companySupervisor } from "./company-supervisor.js";
import { companyTools } from "./company-tools.js";
import { taskRunner } from "./task-runner.js";

const at = "2026-11-09T12:00:00Z";
const initiative: InitiativeRecord = {
  id: "launch",
  projectId: "coach",
  title: "Launch",
  outcome: "Ship onboarding",
  acceptance: "Verified signup",
  managerThreadId: "lead",
  priority: "high",
  state: "active",
  constraints: "Synthetic work only",
  knowledgeIds: [],
  version: 1,
  createdAt: at,
  updatedAt: at,
};
const human = { kind: "human" as const, id: "owner" };

it("runs organization proposal → exact approval → bounded delegation → review → reporting with durable retries", async () => {
  const f = await chiefFixture();
  const api = companyApi(f.context);
  const tool = companyTools(f.context);
  let watcher: ReturnType<typeof companySupervisor> | undefined;
  try {
    const call = (action: string, request: Record<string, unknown> = {}, key = action) =>
      tool.call({ actor: f.actor, arguments: { action, request, key }, idempotencyKey: key });
    expect(JSON.stringify(await call("describe")).length).toBeLessThan(4000);
    const proposal = {
      id: "org",
      projectId: "coach",
      title: "Launch organization",
      explanation: "Own and verify onboarding",
      changes: [
        {
          kind: "team",
          id: "eng",
          name: "Engineering",
          parent: { type: "project", id: "coach" },
          why: "Own delivery",
        },
        {
          kind: "chat",
          id: "lead",
          title: "Engineering lead",
          parent: { type: "subproject", id: "eng" },
          profileId: "profile",
          manager: true,
          why: "Coordinate work",
        },
        {
          kind: "initiative",
          value: { ...initiative, teamId: "eng" },
          why: "Track the launch outcome",
        },
        {
          kind: "remit",
          value: {
            id: "lead",
            threadId: "lead",
            projectId: "coach",
            responsibilities: "Deliver onboarding",
            capabilities: "Delegate and verify",
            boundaries: "No publishing",
            escalation: "Ask about launch changes",
            version: 1,
            updatedAt: at,
          },
          why: "Make ownership clear",
        },
      ],
      authority: {
        initiativeId: "launch",
        maxTasks: 2,
        permissionCeiling: "read_only",
        budgetUsd: 1,
      },
    };
    expect(await call("propose", proposal)).toMatchObject({ status: "proposed" });
    expect(f.f.store.record("subproject", "eng")).toBeUndefined();
    const plan = f.f.store.record("companyPlan", "org") as CompanyPlan;
    const decision = { id: plan.id, version: plan.version, baseline: plan.baseline, approve: true };
    await expect(api("company.decide", decision, "agent-decision", f.actor)).rejects.toThrow(
      "human_approval",
    );
    await api("company.decide", decision, "approve-org");
    expect(await api("company.decide", decision, "approve-org")).toMatchObject({
      state: "applied",
    });
    const task = {
      id: "design",
      title: "Design onboarding",
      brief: "Describe the flow",
      acceptance: "Include error states",
      profileId: "profile",
      node: { type: "subproject", id: "eng" },
      initiativeId: "launch",
      accountableThreadId: "lead",
      budgetUsd: 0.4,
      planned: true,
    };
    await call("assign", { value: task, planId: "org" }, "design");
    await call("assign", { value: task, planId: "org" }, "design");
    expect(f.f.store.snapshot(["task"]).task).toHaveLength(1);
    await expect(
      call(
        "assign",
        { value: { ...task, id: "too-expensive", budgetUsd: 0.7 }, planId: "org" },
        "expensive",
      ),
    ).rejects.toThrow("budget_limit");
    await call(
      "assign",
      { value: { ...task, id: "verify", dependencies: ["design"] }, planId: "org" },
      "verify",
    );
    await expect(
      call("assign", { value: { ...task, id: "extra" }, planId: "org" }, "extra"),
    ).rejects.toThrow("task_limit");
    const read = (await call("read", { projectId: "coach", section: "initiatives" })) as {
      initiatives: unknown[];
    };
    expect(read.initiatives).toHaveLength(1);
    expect(JSON.stringify(read).length).toBeLessThan(4000);
    await api(
      "company.brief",
      { projectId: "coach", summary: "Design and verification planned." },
      "brief",
    );
    expect(f.f.store.snapshot(["projectBrief"]).projectBrief?.[0]).toMatchObject({ revision: 1 });
    watcher = companySupervisor(f.context, { now: () => at, intervalMs: 60_000 });
    await watcher.tick();
    const count = f.f.store.lastSeq();
    await watcher.tick();
    expect(f.f.store.lastSeq()).toBe(count);
    watcher.close();
    watcher = companySupervisor(f.context, { now: () => at, intervalMs: 60_000 });
    await watcher.tick();
    expect(f.f.store.lastSeq()).toBe(count);
  } finally {
    watcher?.close();
    f.f.close();
  }
});
it("dispatches linked manager assignments through the existing runner and preserves hop provenance", async () => {
  const f = await chiefFixture();
  const api = companyApi(f.context);
  const plan = (await api(
    "company.propose",
    {
      id: "lead-plan",
      projectId: "coach",
      title: "Create lead",
      explanation: "Handle a bug",
      changes: [
        {
          kind: "chat",
          id: "lead",
          title: "Lead",
          profileId: "profile",
          parent: { type: "project", id: "coach" },
          manager: true,
          why: "Coordinate this fix",
        },
      ],
    },
    "propose-lead",
  )) as CompanyPlan;
  await api(
    "company.decide",
    { id: plan.id, version: plan.version, baseline: plan.baseline, approve: true },
    "approve-lead",
  );
  const wakes: string[] = [];
  const runner = taskRunner({
    store: f.f.store,
    publish() {},
    checkPublic: async () => () => {},
    wake: async (id) => {
      wakes.push(id);
    },
    routinePollMs: 60_000,
  });
  try {
    // Human-created direct task: no initiative, no manager assignment required.
    await api(
      "company.assign",
      {
        value: {
          id: "bug",
          title: "Fix bug",
          brief: "Fix the synthetic bug",
          profileId: "profile",
          node: { type: "project", id: "coach" },
        },
      },
      "direct-bug",
    );
    await runner.schedule();
    expect(f.f.store.record("task", "bug")).toMatchObject({ state: "running" });
    expect(wakes).toContain("bug:thread");
    const queued = f.f.store.snapshot(["item"]).item?.find((r) => r.threadId === "bug:thread");
    expect(JSON.stringify(queued)).toContain("Fix the synthetic bug");
    f.f.store.dispatch("finish-bug", (state) =>
      finishTaskTurn(
        state,
        "bug",
        1,
        { status: "completed", text: "Fixed; verification passed." },
        { commandId: "finish-bug", at, actor: { kind: "system", id: "test" } },
      ),
    );
    expect(f.f.store.record("task", "bug")).toMatchObject({ state: "review" });
    f.f.store.dispatch("accept-bug", (state) =>
      handle(
        state,
        { type: "review", id: "bug", revision: 1, decision: "accept" },
        { commandId: "accept-bug", at, actor: human },
      ),
    );
    expect(f.f.store.record("task", "bug")).toMatchObject({ state: "completed" });
  } finally {
    runner.close();
    f.f.close();
  }
});
it("defers running accountability handoff and reconciles each notice once after recovery", async () => {
  const f = await chiefFixture(),
    api = companyApi(f.context);
  let watcher: ReturnType<typeof companySupervisor> | undefined;
  try {
    await api(
      "company.assign",
      {
        value: {
          id: "bug",
          title: "Fix bug",
          brief: "Synthetic",
          profileId: "profile",
          node: { type: "project", id: "coach" },
          accountableThreadId: "worker",
        },
      },
      "bug",
    );
    f.f.store.dispatch("start", (s) =>
      startTask(s, "bug", 1, { commandId: "start", at, actor: { kind: "system", id: "test" } }),
    );
    const plan = (await api(
      "company.propose",
      {
        id: "handoff",
        projectId: "coach",
        title: "Handoff",
        explanation: "New owner",
        changes: [
          { kind: "assignTask", id: "bug", accountableThreadId: "thread", why: "Chief follows up" },
        ],
      },
      "handoff-plan",
    )) as CompanyPlan;
    await api(
      "company.decide",
      { id: plan.id, version: 1, baseline: plan.baseline, approve: true },
      "handoff-approve",
    );
    expect(f.f.store.record("task", "bug")).toMatchObject({
      accountableThreadId: "worker",
      pendingAccountableThreadId: "thread",
    });
    f.f.store.dispatch("finish", (s) =>
      finishTaskTurn(
        s,
        "bug",
        1,
        { status: "completed", text: "Evidence" },
        { commandId: "finish", at, actor: { kind: "system", id: "test" } },
      ),
    );
    watcher = companySupervisor(f.context, { now: () => at });
    await watcher.tick();
    expect(f.f.store.record("task", "bug")).toMatchObject({ accountableThreadId: "thread" });
    expect(f.f.store.record("task", "bug")?.pendingAccountableThreadId).toBeUndefined();
    const notices = () =>
      f.f.store.snapshot(["item"]).item?.filter((r) => String(r.id).startsWith("company:signal:"));
    expect(notices()).toHaveLength(1);
    watcher.close();
    watcher = companySupervisor(f.context, { now: () => at });
    await watcher.tick();
    expect(notices()).toHaveLength(1);
  } finally {
    watcher?.close();
    f.f.close();
  }
});
