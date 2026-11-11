import type { CompanyPlan, InitiativeRecord } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { chiefFixture } from "./chief/test-fixture.js";
import { companyApi } from "./company-api.js";
import { companySupervisor } from "./company-supervisor.js";
import { companyTools } from "./company-tools.js";

const at = "2026-11-09T12:00:00Z";

function baseInitiative(overrides: Partial<InitiativeRecord> = {}): InitiativeRecord {
  return {
    id: "sla-init",
    projectId: "coach",
    teamId: "ops",
    title: "VIP SLA reliability",
    outcome: "Route VIP incidents within 5 minutes",
    acceptance: "All SLA unit tests pass",
    managerThreadId: "ops-lead",
    priority: "urgent",
    state: "active",
    constraints: "Keep existing public endpoints unchanged",
    knowledgeIds: [],
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

it("returns compact brief receipts without result_too_large and deduplicates same-day retries while preserving meaningful revisions", async () => {
  const f = await chiefFixture();
  const api = companyApi(f.context);
  const tool = companyTools(f.context);
  try {
    const call = (action: string, request: Record<string, unknown> = {}, key = action) =>
      tool.call({ actor: f.actor, arguments: { action, request, key }, idempotencyKey: key });

    const plan = (await api(
      "company.propose",
      {
        id: "ops-plan",
        projectId: "coach",
        title: "Ops initiative",
        explanation: "Create large evidence footprint",
        changes: [
          {
            kind: "team",
            id: "ops",
            name: "Operations",
            parent: { type: "project", id: "coach" },
            why: "Own SLA",
          },
          {
            kind: "chat",
            id: "ops-lead",
            title: "Operations Lead",
            parent: { type: "subproject", id: "ops" },
            profileId: "profile",
            manager: true,
            why: "Coordinate SLA",
          },
          {
            kind: "initiative",
            value: baseInitiative(),
            why: "Track SLA",
          },
          ...Array.from({ length: 12 }, (_, idx) => ({
            kind: "task" as const,
            value: {
              id: `task-${idx + 1}`,
              title: `SLA check #${idx + 1}: verify VIP routing precedence`,
              brief: `Investigate SLA path ${idx + 1}. ${"Context line ".repeat(30)}`,
              acceptance: `Verify assertion suite ${idx + 1}. ${"Criteria ".repeat(55)}`,
              profileId: "profile",
              node: { type: "subproject" as const, id: "ops" },
              initiativeId: "sla-init",
              accountableThreadId: "ops-lead",
              planned: true,
            },
            why: `Planned item ${idx + 1}`,
          })),
        ],
        authority: {
          initiativeId: "sla-init",
          maxTasks: 20,
          reviewTasks: true,
          permissionCeiling: "workspace_write",
          budgetUsd: 10,
        },
      },
      "propose-ops",
      f.actor,
    )) as CompanyPlan;

    await api(
      "company.decide",
      { id: plan.id, version: plan.version, baseline: plan.baseline, approve: true },
      "approve-ops",
    );

    // Supervisor auto-briefs update `:auto` in place across state transitions instead of appending revisions.
    const watcher = companySupervisor(f.context, {
      now: () => new Date().toISOString(),
      intervalMs: 60_000,
    });
    try {
      await watcher.tick();
      await call("dispatch", { taskId: "task-1", planId: plan.id }, "disp-task-1");
      await watcher.tick();
      const autoBriefs = (f.f.store.snapshot(["projectBrief"]).projectBrief ?? []).filter((b) =>
        Boolean(b.auto),
      );
      expect(autoBriefs).toHaveLength(1);
      expect(String(autoBriefs[0]?.id)).toContain(":auto");

      // Unscoped `company_work(read)` across all 11 sections stays strictly under the 4000-char hostmcp limit!
      const unscopedOverview = (await call("read", { projectId: "coach" })) as {
        counts: { tasks: number; plans: number };
        hasMore?: boolean;
      };
      expect(JSON.stringify(unscopedOverview).length).toBeLessThan(3800);
      expect(unscopedOverview.counts).toMatchObject({ tasks: 12, plans: 1 });
      expect(unscopedOverview.hasMore).toBe(true);

      const summary =
        "VIP SLA initiative approved; 12 tasks queued with clear acceptance criteria.";
      const receipt1 = (await call("brief", { projectId: "coach", summary }, "brief-key-1")) as {
        id: string;
        revision: number;
        deduplicated?: boolean;
        evidenceCounts: { initiatives: number; tasks: number };
      };
      // Tool output stays well below the 4000-char hostmcp limit even when persisted evidence is > 8KB!
      expect(JSON.stringify(receipt1).length).toBeLessThan(1000);
      expect(receipt1).toMatchObject({
        projectId: "coach",
        revision: 1,
        evidenceCounts: { initiatives: 1, tasks: 12 },
      });
      expect(receipt1.deduplicated).toBeUndefined();

      const manualBriefsAfter1 = (f.f.store.snapshot(["projectBrief"]).projectBrief ?? []).filter(
        (b) => !b.auto,
      );
      expect(manualBriefsAfter1).toHaveLength(1);
      expect(JSON.stringify(manualBriefsAfter1[0]?.evidence).length).toBeGreaterThan(4000);

      // Subsequent supervisor ticks do NOT append auto-briefs over the authored manual brief!
      await call("dispatch", { taskId: "task-2", planId: plan.id }, "disp-task-2");
      await watcher.tick();
      expect(f.f.store.snapshot(["projectBrief"]).projectBrief).toHaveLength(2);

      // Retrying the same summary even with a different key deduplicates instead of creating revision 2!
      const retryReceipt = (await call(
        "brief",
        { projectId: "coach", summary },
        "brief-key-2",
      )) as {
        revision: number;
        deduplicated?: boolean;
      };
      expect(retryReceipt).toMatchObject({ revision: 1, deduplicated: true });
      expect(
        (f.f.store.snapshot(["projectBrief"]).projectBrief ?? []).filter((b) => !b.auto),
      ).toHaveLength(1);

      // Saving an updated summary creates manual revision 2 cleanly.
      const receipt2 = (await call(
        "brief",
        { projectId: "coach", summary: "Task 1 dispatched and verified; 10 tasks remain planned." },
        "brief-key-3",
      )) as { revision: number; deduplicated?: boolean };
      expect(receipt2.revision).toBe(2);
      expect(receipt2.deduplicated).toBeUndefined();
      expect(
        (f.f.store.snapshot(["projectBrief"]).projectBrief ?? []).filter((b) => !b.auto),
      ).toHaveLength(2);
    } finally {
      watcher.close();
    }
  } finally {
    f.f.close();
  }
});

it("supports scoped and paginated company_work reads, singular section aliases, and independent review routing", async () => {
  const f = await chiefFixture();
  const api = companyApi(f.context);
  const tool = companyTools(f.context);
  try {
    const plan = (await api(
      "company.propose",
      {
        id: "review-plan",
        projectId: "coach",
        title: "Review and pagination plan",
        explanation: "Set up manager and tasks",
        changes: [
          {
            kind: "team",
            id: "ops",
            name: "Operations",
            parent: { type: "project", id: "coach" },
            why: "Own SLA",
          },
          {
            kind: "chat",
            id: "ops-lead",
            title: "Operations Lead",
            parent: { type: "subproject", id: "ops" },
            profileId: "profile",
            manager: true,
            why: "Coordinate SLA",
          },
          {
            kind: "initiative",
            value: baseInitiative(),
            why: "Track SLA",
          },
          ...Array.from({ length: 5 }, (_, idx) => ({
            kind: "task" as const,
            value: {
              id: `t-${idx + 1}`,
              title: `Task ${idx + 1}`,
              brief: `Execute step ${idx + 1}`,
              acceptance: "Pass tests",
              profileId: "profile",
              node: { type: "subproject" as const, id: "ops" },
              initiativeId: "sla-init",
              accountableThreadId: "ops-lead",
              planned: true,
            },
            why: `Create task ${idx + 1}`,
          })),
        ],
        authority: {
          initiativeId: "sla-init",
          maxTasks: 10,
          reviewTasks: true,
          permissionCeiling: "workspace_write",
          budgetUsd: 5,
        },
      },
      "propose-review-plan",
      f.actor,
    )) as CompanyPlan;

    await api(
      "company.decide",
      { id: plan.id, version: plan.version, baseline: plan.baseline, approve: true },
      "approve-review-plan",
    );

    const managerActor = {
      agentId: "profile",
      threadId: "ops-lead",
      sessionId: "mgr-session",
      turnId: "mgr-turn",
    };

    // Manager calling read with singular alias `section: "task"` and NO projectId resolves its project automatically!
    const page1 = (await tool.call({
      actor: managerActor,
      arguments: { action: "read", request: { section: "task", offset: 0, limit: 2 } },
      idempotencyKey: "mgr-read-1",
    })) as {
      projectId: string;
      tasks: { id: string }[];
      counts: { tasks: number };
      hasMore?: boolean;
    };
    expect(page1.projectId).toBe("coach");
    expect(page1.counts.tasks).toBe(5);
    expect(page1.tasks.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect(page1.hasMore).toBe(true);

    // Reading a single large plan by id never wipes `plans` to `[]`.
    const singlePlan = (await tool.call({
      actor: f.actor,
      arguments: { action: "read", request: { section: "plan", id: "review-plan" } },
      idempotencyKey: "chief-read-plan",
    })) as { plans: { id: string }[]; counts: { plans: number } };
    expect(singlePlan.counts.plans).toBe(1);
    expect(singlePlan.plans).toHaveLength(1);
    expect(singlePlan.plans[0]?.id).toBe("review-plan");

    // Unknown section returns an actionable snake_case error.
    await expect(
      tool.call({
        actor: managerActor,
        arguments: { action: "read", request: { section: "bogus" } },
        idempotencyKey: "bad-sec",
      }),
    ).rejects.toThrow("invalid_section:");

    // Manager executes `t-1` directly via `submit`, then cannot self-review (`independent_reviewer_required`),
    // while Chief (independent reviewer with `reviewTasks: true`) accepts it via `company_work(review)`!
    const submitted = (await tool.call({
      actor: managerActor,
      arguments: {
        action: "submit",
        key: "mgr-submit-t1",
        request: {
          taskId: "t-1",
          status: "done",
          summary: "Fixed directly and verified unit tests.",
          files: ["src/sla.js"],
          planId: "review-plan",
        },
      },
      idempotencyKey: "mgr-sub-1",
    })) as { task: { state: string; executorThreadId: string } };
    expect(submitted.task).toMatchObject({ state: "review", executorThreadId: "ops-lead" });

    await expect(
      tool.call({
        actor: managerActor,
        arguments: {
          action: "review",
          key: "mgr-self-review",
          request: { taskId: "t-1", revision: 1, decision: "accept", planId: "review-plan" },
        },
        idempotencyKey: "mgr-rev-1",
      }),
    ).rejects.toThrow("independent_reviewer_required");

    const reviewed = (await tool.call({
      actor: f.actor,
      arguments: {
        action: "review",
        key: "chief-review-t1",
        request: { taskId: "t-1", revision: 1, decision: "accept", planId: "review-plan" },
      },
      idempotencyKey: "chief-rev-1",
    })) as { id: string; state: string; reviewState: string };
    expect(reviewed).toMatchObject({ id: "t-1", state: "completed", reviewState: "accept" });
  } finally {
    f.f.close();
  }
});
