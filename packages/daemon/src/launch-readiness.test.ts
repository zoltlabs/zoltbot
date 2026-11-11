import { createTask, handle } from "@zoltbot/core";
import { upsertKnowledge } from "@zoltbot/knowledge";
import { ProfileSchema, parse, ThreadSchema } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { companyApi } from "./company-api.js";
import { knowledgeLaunch } from "./knowledge-launch.js";
import { PrivateInputGuard } from "./private-input.js";
import { taskRunner } from "./task-runner.js";

it("exposes launch readiness, distinguishes required vs optional knowledge holds, and supports bounded recovery", async () => {
  const f = await runtimeFixture();
  let n = 0;
  const ctx = () => ({
    commandId: `lr:${++n}`,
    at,
    actor: { kind: "human" as const, id: "local-owner" },
  });
  const dispatch = (fn: Parameters<typeof f.store.dispatch>[1]) =>
    f.store.dispatch(`lr-dispatch:${++n}`, fn);

  try {
    dispatch((s) =>
      handle(
        s,
        {
          type: "create",
          kind: "project",
          value: {
            id: "harbor",
            name: "HarborDesk",
            goal: "Build and maintain HarborDesk support routing.",
            instructions: "Run node --test before reporting completion.",
            constraints: "Preserve public exports.",
            roots: [{ label: "repo", path: f.root }],
            hierarchyDepth: 2,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        ctx(),
      ),
    );
    dispatch((s) =>
      handle(
        s,
        {
          type: "update",
          kind: "thread",
          id: "thread",
          changes: {
            kind: "manager",
            projectId: "harbor",
            node: { type: "project", id: "harbor" },
          },
        },
        ctx(),
      ),
    );
    const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
    const api = companyApi({
      store: f.store,
      privacy,
      publish() {},
      async wake() {},
    });
    dispatch((s) =>
      upsertKnowledge(
        s,
        {
          id: "req-spec",
          scope: { type: "project", id: "harbor" },
          kind: "constraint",
          title: "SLA constraint",
          body: "VIP tickets must preserve deterministic SLA timestamps.",
          status: "active",
          tags: [],
          sources: [],
          revision: 1,
          owner: { kind: "human", id: "local-owner" },
          verification: "human",
          writer: { kind: "human", id: "local-owner" },
          createdAt: at,
          updatedAt: at,
          pinned: true,
        },
        0,
        ctx(),
      ),
    );
    dispatch((s) =>
      upsertKnowledge(
        s,
        {
          id: "opt-notes",
          scope: { type: "project", id: "harbor" },
          kind: "lesson",
          title: "Extended historical triage notes",
          body: "Historical migration background ".repeat(30),
          status: "active",
          tags: [],
          sources: [],
          revision: 1,
          owner: { kind: "human", id: "local-owner" },
          verification: "human",
          writer: { kind: "human", id: "local-owner" },
          createdAt: at,
          updatedAt: at,
          pinned: false,
        },
        0,
        ctx(),
      ),
    );
    dispatch((s) =>
      upsertKnowledge(
        s,
        {
          id: "opt-notes-2",
          scope: { type: "project", id: "harbor" },
          kind: "lesson",
          title: "Legacy archive triage notes",
          body: "Legacy archive notes for old imports ".repeat(30),
          status: "active",
          tags: [],
          sources: [],
          revision: 1,
          owner: { kind: "human", id: "local-owner" },
          verification: "human",
          writer: { kind: "human", id: "local-owner" },
          createdAt: at,
          updatedAt: at,
          pinned: false,
        },
        0,
        ctx(),
      ),
    );

    const proposed = (await api(
      "company.propose",
      {
        id: "plan-lr",
        projectId: "harbor",
        title: "VIP triage",
        explanation: "Set up initiative and authority.",
        changes: [
          {
            kind: "initiative",
            why: "Track VIP triage",
            value: {
              id: "init-lr",
              projectId: "harbor",
              title: "VIP triage",
              outcome: "Fix VIP routing",
              acceptance: "Tests pass",
              managerThreadId: "thread",
              priority: "high",
              state: "active",
              constraints: "Keep schema stable",
              knowledgeIds: ["req-spec"],
              version: 1,
              createdAt: at,
              updatedAt: at,
            },
          },
        ],
        authority: {
          initiativeId: "init-lr",
          maxTasks: 5,
          reviewTasks: true,
          permissionCeiling: "workspace_write",
          budgetUsd: 25,
        },
      },
      "cmd:propose",
    )) as { version: number; baseline: string };
    await api(
      "company.decide",
      { id: "plan-lr", version: proposed.version, baseline: proposed.baseline, approve: true },
      "cmd:decide",
    );

    dispatch((s) => {
      const created = createTask(
        s,
        {
          id: "task-opt",
          title: "Fix VIP SLA",
          brief: "Fix VIP routing and historical triage",
          node: { type: "project", id: "harbor" },
          profileId: "profile",
          routineInputs: {
            knowledge: ["req-spec", "opt-notes", "opt-notes-2"],
            skills: [],
            connections: [],
          },
        },
        ctx(),
      );
      const events = created.events.map((event) =>
        event.aggregateType === "task" && event.type === "task.created"
          ? {
              ...event,
              payload: {
                ...(event.payload as Record<string, unknown>),
                initiativeId: "init-lr",
                accountableThreadId: "thread",
                authorityPlanId: "plan-lr",
              },
            }
          : event,
      );
      return { events, result: created.result };
    });

    const managerActor = {
      agentId: "profile",
      threadId: "thread",
      sessionId: "session",
      turnId: "turn",
    };
    const initialView = (await api(
      "company.read",
      { projectId: "harbor" },
      undefined,
      managerActor,
    )) as {
      tasks: {
        id: string;
        launchReadiness?: {
          ready: boolean;
          fixed: number;
          remaining: number;
          requiredKnowledgeIds?: string[];
          optionalKnowledgeIds?: string[];
          overflowIds?: string[];
          blocker?: string;
        };
      }[];
    };
    const readinessBefore = initialView.tasks.find((t) => t.id === "task-opt")?.launchReadiness;
    expect(readinessBefore).toBeDefined();
    expect(readinessBefore?.fixed).toBeLessThan(1250);
    expect(readinessBefore?.ready).toBe(false);
    expect(readinessBefore?.requiredKnowledgeIds).toContain("req-spec");
    expect(readinessBefore?.optionalKnowledgeIds).toEqual(
      expect.arrayContaining(["opt-notes", "opt-notes-2"]),
    );
    expect(readinessBefore?.overflowIds?.length).toBeGreaterThan(0);
    expect(readinessBefore?.blocker).toContain("optional_knowledge_exceeds_budget:");

    const runner = taskRunner({
      store: f.store,
      publish() {},
      checkPublic: async () => () => {},
      preflight: async (threadId) => {
        const thread = parse(ThreadSchema, f.store.record("thread", threadId));
        const profile = parse(ProfileSchema, f.store.record("agent", thread.agentId));
        const fakeDef = f.store.snapshot(["agentDefinition"]).agentDefinition?.[0];
        knowledgeLaunch(
          f.store,
          {
            thread,
            profile,
            definition: fakeDef as never,
          },
          readinessBefore?.remaining ?? 300,
        );
      },
    });
    await runner.schedule();
    runner.close();

    expect(f.store.record("task", "task-opt")?.holdReason).toContain(
      "context_budget_hold: Optional knowledge (",
    );

    // Non-human recovery cannot exclude required constraint/initiative knowledge.
    await expect(
      api(
        "company.recover",
        {
          taskId: "task-opt",
          planId: "plan-lr",
          excludeOptionalKnowledgeIds: ["req-spec"],
        },
        "cmd:recover-bad",
        managerActor,
      ),
    ).rejects.toThrow("required_context_cannot_be_excluded");

    // Bounded recovery excludes optional knowledge only and clears the hold while keeping req-spec.
    await api(
      "company.recover",
      {
        taskId: "task-opt",
        planId: "plan-lr",
        excludeOptionalKnowledgeIds: readinessBefore?.overflowIds ?? ["opt-notes-2"],
      },
      "cmd:recover-ok",
      managerActor,
    );
    expect(f.store.record("task", "task-opt")?.holdReason).toBeUndefined();
    const afterView = (await api(
      "company.read",
      { projectId: "harbor" },
      undefined,
      managerActor,
    )) as typeof initialView;
    const readinessAfter = afterView.tasks.find((t) => t.id === "task-opt")?.launchReadiness;
    expect(readinessAfter?.ready).toBe(true);
    expect(readinessAfter?.requiredKnowledgeIds).toContain("req-spec");
  } finally {
    f.close();
  }
});
