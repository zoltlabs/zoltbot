import { finishTaskTurn, handle, startTask } from "@zoltbot/core";
import type { CompanyPlan, InitiativeRecord } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { startDaemon } from "./api.js";
import { chiefFixture } from "./chief/test-fixture.js";
import { companyApi } from "./company-api.js";
import { companySupervisor } from "./company-supervisor.js";
import { companyTools } from "./company-tools.js";
import { taskRunner } from "./task-runner.js";

const at = "2026-11-09T12:00:00Z";

function mkInitiative(id: string, overrides: Partial<InitiativeRecord> = {}): InitiativeRecord {
  return {
    id,
    projectId: "coach",
    title: `Initiative ${id}`,
    outcome: `Deliver ${id}`,
    acceptance: `Verify ${id}`,
    priority: "normal",
    state: "active",
    constraints: "Local synthetic scope only",
    knowledgeIds: [],
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

it("survives daemon restart during a running-work reorg handoff and deduplicates repeated deliveries", async () => {
  const seed = await runtimeFixture("zoltbot.db");
  const dataDir = seed.root;
  // Close the fixture's direct SQLite handle before starting the daemon on `zoltbot.db`.
  seed.store.close();
  let daemon = await startDaemon({ dataDir });
  try {
    const setupAt = new Date().toISOString();
    daemon.dispatch(
      {
        type: "create",
        kind: "project",
        value: {
          id: "coach",
          name: "Coach",
          goal: "Ship pilot",
          instructions: "",
          constraints: "Local only",
          roots: [],
          hierarchyDepth: 3,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: setupAt,
        },
      },
      "seed-project",
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "thread",
        value: {
          id: "chief",
          agentId: "profile",
          kind: "main",
          title: "Chief",
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: setupAt,
          lastActivityAt: setupAt,
        },
      },
      "seed-chief",
    );
    daemon.dispatch(
      { type: "create", kind: "settings", value: { key: "chief.thread", value: "chief" } },
      "seed-chief-setting",
    );

    const connectRpc = async (d: Awaited<ReturnType<typeof startDaemon>>) => {
      const ws = new WebSocket(d.url);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws_open_failed")), { once: true });
      });
      let seq = 0;
      const rpc = (method: string, params: unknown, commandId?: string) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++seq;
          const onMsg = (ev: MessageEvent) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.id !== id) return;
            ws.removeEventListener("message", onMsg);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          };
          ws.addEventListener("message", onMsg);
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params,
              ...(commandId ? { commandId } : {}),
            }),
          );
        });
      await rpc("hello", { protocolVersion: 1, token: d.token });
      return { ws, rpc };
    };

    let conn = await connectRpc(daemon);
    const orgPlan = (await conn.rpc(
      "company.propose",
      {
        id: "plan-1",
        projectId: "coach",
        title: "Initial org",
        explanation: "Create team, two leads, initiative, and planned task",
        changes: [
          {
            kind: "team",
            id: "eng",
            name: "Pilot Engineering",
            parent: { type: "project", id: "coach" },
            why: "Own pilot",
          },
          {
            kind: "chat",
            id: "lead-1",
            title: "Pilot Lead",
            parent: { type: "subproject", id: "eng" },
            profileId: "profile",
            manager: true,
            why: "Initial lead",
          },
          {
            kind: "chat",
            id: "lead-2",
            title: "Reliability Lead",
            parent: { type: "project", id: "coach" },
            profileId: "profile",
            manager: true,
            why: "Handoff lead",
          },
          {
            kind: "initiative",
            value: mkInitiative("vip", {
              teamId: "eng",
              managerThreadId: "lead-1",
              createdAt: setupAt,
              updatedAt: setupAt,
            }),
            why: "Track VIP fix",
          },
          {
            kind: "task",
            value: {
              id: "vip-fix",
              title: "Fix VIP routing",
              brief: "Route VIP ahead of low priority",
              acceptance: "Unit test passes",
              profileId: "profile",
              node: { type: "subproject", id: "eng" },
              initiativeId: "vip",
              accountableThreadId: "lead-1",
              planned: true,
              budgetUsd: 0.4,
            },
            why: "Planned commitment",
          },
        ],
        authority: {
          initiativeId: "vip",
          maxTasks: 2,
          reviewTasks: true,
          permissionCeiling: "workspace_write",
          budgetUsd: 1,
        },
      },
      "propose-plan-1",
    )) as CompanyPlan;

    // Duplicate decide delivery with the same commandId is idempotent.
    await conn.rpc(
      "company.decide",
      { id: orgPlan.id, version: 1, baseline: orgPlan.baseline, approve: true },
      "decide-plan-1",
    );
    const dupDecide = await conn.rpc(
      "company.decide",
      { id: orgPlan.id, version: 1, baseline: orgPlan.baseline, approve: true },
      "decide-plan-1",
    );
    expect(dupDecide).toMatchObject({ id: "plan-1", state: "applied" });

    // Dispatch planned task with duplicate delivery (same commandId, and second call after planned=false).
    await conn.rpc("company.dispatch", { taskId: "vip-fix", planId: "plan-1" }, "dispatch-vip-fix");
    await conn.rpc("company.dispatch", { taskId: "vip-fix", planId: "plan-1" }, "dispatch-vip-fix");
    expect(daemon.store.snapshot(["task"]).task).toHaveLength(1);

    // Put `vip-fix` into active running execution if not already started by background runner.
    const currentTask = daemon.store.record("task", "vip-fix");
    if (currentTask?.state === "queued") {
      daemon.store.dispatch("force-start", (s) =>
        startTask(s, "vip-fix", 1, {
          commandId: "force-start",
          at: new Date().toISOString(),
          actor: { kind: "system", id: "test" },
        }),
      );
    }
    expect(daemon.store.record("task", "vip-fix")?.state).toBe("running");

    // Apply an approved reorg (team rename + running task accountability transfer) while `vip-fix` is running!
    const reorgPlan = (await conn.rpc(
      "company.propose",
      {
        id: "plan-reorg",
        projectId: "coach",
        title: "Customer Reliability reorg",
        explanation: "Rename team and hand off running VIP task to Reliability Lead",
        changes: [
          {
            kind: "renameTeam",
            id: "eng",
            name: "Customer Reliability",
            why: "Retention focus",
          },
          {
            kind: "assignTask",
            id: "vip-fix",
            accountableThreadId: "lead-2",
            why: "Transfer supervision cleanly at turn boundary",
          },
        ],
      },
      "propose-reorg",
    )) as CompanyPlan;

    await conn.rpc(
      "company.decide",
      { id: reorgPlan.id, version: 1, baseline: reorgPlan.baseline, approve: true },
      "decide-reorg",
    );

    expect(daemon.store.record("subproject", "eng")?.name).toBe("Customer Reliability");
    expect(daemon.store.record("task", "vip-fix")).toMatchObject({
      state: "running",
      accountableThreadId: "lead-1",
      pendingAccountableThreadId: "lead-2",
    });

    // Restart the daemon process mid-handoff on the same SQLite directory!
    conn.ws.close();
    await daemon.close();
    daemon = await startDaemon({ dataDir });
    conn = await connectRpc(daemon);

    // `startDaemon` reconciles interrupted running work to `blocked` and transfers deferred handoff to `lead-2` on boot!
    const afterRestart = daemon.store.record("task", "vip-fix");
    expect(afterRestart).toMatchObject({
      state: "blocked",
      accountableThreadId: "lead-2",
    });
    expect(afterRestart?.pendingAccountableThreadId).toBeUndefined();

    // Reconcile on the restarted daemon -> handoff completes to `lead-2` at the restart boundary,
    // `lead-2` recovers the interrupted task, and finishes it cleanly to `review` without duplicate signals!
    const watcher = companySupervisor(
      {
        store: daemon.store,
        privacy: { prepareData: async () => () => {} } as never,
        publish: () => {},
        wake: async () => {},
      },
      { now: () => new Date().toISOString() },
    );
    try {
      await watcher.tick();
      expect(daemon.store.record("task", "vip-fix")).toMatchObject({
        accountableThreadId: "lead-2",
      });
      expect(daemon.store.record("task", "vip-fix")?.pendingAccountableThreadId).toBeUndefined();

      if (daemon.store.record("task", "vip-fix")?.state === "blocked") {
        await conn.rpc("company.recover", { taskId: "vip-fix", planId: "plan-1" }, "recover-vip");
        const recovered = daemon.store.record("task", "vip-fix");
        if (recovered?.state === "queued") {
          daemon.store.dispatch("restart-vip", (s) =>
            startTask(s, "vip-fix", Number(recovered.revision ?? 2), {
              commandId: "restart-vip",
              at: new Date().toISOString(),
              actor: { kind: "system", id: "test" },
            }),
          );
        }
      }
      const runningAgain = daemon.store.record("task", "vip-fix");
      if (runningAgain?.state === "running") {
        daemon.store.dispatch("finish-vip", (s) =>
          finishTaskTurn(
            s,
            "vip-fix",
            Number(runningAgain.revision ?? 2),
            { status: "completed", text: "VIP routing fixed and verified." },
            {
              commandId: "finish-vip",
              at: new Date().toISOString(),
              actor: { kind: "system", id: "test" },
            },
          ),
        );
      }
      await watcher.tick();
      await watcher.tick();
    } finally {
      watcher.close();
    }

    expect(daemon.store.record("task", "vip-fix")).toMatchObject({
      state: "review",
      accountableThreadId: "lead-2",
    });
    expect(daemon.store.record("task", "vip-fix")?.pendingAccountableThreadId).toBeUndefined();
    const reviewSignalsForLead2 = (daemon.store.snapshot(["item"]).item ?? []).filter(
      (i) =>
        String(i.id).startsWith("company:signal:") &&
        String(i.id).includes(":review:") &&
        i.threadId === "lead-2",
    );
    expect(reviewSignalsForLead2).toHaveLength(1);
    conn.ws.close();
  } finally {
    await daemon.close().catch(() => {});
    seed.close();
  }
});

it("enforces initiative freezes, dependency failures, cancellation reservation release, context recovery, and scope limits", async () => {
  const f = await chiefFixture();
  const api = companyApi(f.context);
  const tool = companyTools(f.context);
  const interrupted: string[] = [];
  const contextWithInterrupt = {
    ...f.context,
    interrupt: async (threadId: string, turnId: string) => {
      interrupted.push(`${threadId}:${turnId}`);
    },
  };
  const toolWithInterrupt = companyTools(contextWithInterrupt);
  const runner = taskRunner({
    store: f.f.store,
    publish() {},
    checkPublic: async () => () => {},
    wake: async () => {},
    routinePollMs: 60_000,
  });
  try {
    // Seed a full_access profile to test unauthorized permission ceiling escalation.
    f.f.store.dispatch("seed-full-profile", (s) =>
      handle(
        s,
        {
          type: "create",
          kind: "agent",
          confirmed: true,
          value: {
            id: "root-profile",
            name: "Root",
            avatar: "R",
            kind: "profile",
            definitionId: "fake",
            permissionProfile: "full_access",
            instructions: "",
            hidden: false,
            archived: false,
          },
        },
        { commandId: "seed-full-profile", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    // Seed a second project to test cross-project unauthorized scope expansion.
    f.f.store.dispatch("seed-other-project", (s) =>
      handle(
        s,
        {
          type: "create",
          kind: "project",
          value: {
            id: "other",
            name: "Other",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 3,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        { commandId: "seed-other-project", at, actor: { kind: "human", id: "owner" } },
      ),
    );

    const plan = (await api(
      "company.propose",
      {
        id: "pilot-plan",
        projectId: "coach",
        title: "Pilot and VIP plan",
        explanation: "Set up teams, initiatives, and authority",
        changes: [
          {
            kind: "team",
            id: "pilot-team",
            name: "Pilot",
            parent: { type: "project", id: "coach" },
            why: "Pilot work",
          },
          {
            kind: "chat",
            id: "pilot-lead",
            title: "Pilot Lead",
            parent: { type: "subproject", id: "pilot-team" },
            profileId: "profile",
            manager: true,
            why: "Own pilot",
          },
          {
            kind: "initiative",
            value: mkInitiative("pilot", {
              teamId: "pilot-team",
              managerThreadId: "pilot-lead",
            }),
            why: "Pilot checklist",
          },
          {
            kind: "task",
            value: {
              id: "pilot-checklist",
              title: "Draft checklist",
              brief: "Write checklist",
              profileId: "profile",
              node: { type: "subproject", id: "pilot-team" },
              initiativeId: "pilot",
              accountableThreadId: "pilot-lead",
              planned: true,
              budgetUsd: 0.5,
            },
            why: "Checklist item",
          },
        ],
        authority: {
          initiativeId: "pilot",
          maxTasks: 2,
          permissionCeiling: "workspace_write",
          budgetUsd: 0.6,
        },
      },
      "propose-pilot",
      f.actor,
    )) as CompanyPlan;

    await api(
      "company.decide",
      { id: plan.id, version: 1, baseline: plan.baseline, approve: true },
      "approve-pilot",
    );

    const leadActor = {
      agentId: "profile",
      threadId: "pilot-lead",
      sessionId: "lead-sess",
      turnId: "lead-turn",
    };

    // 1. Unauthorized permission expansion (`full_access` > `workspace_write` ceiling) is refused!
    await expect(
      tool.call({
        actor: leadActor,
        arguments: {
          action: "assign",
          key: "escalate-perms",
          request: {
            planId: "pilot-plan",
            value: {
              id: "escalated",
              title: "Escalated",
              brief: "Try full_access",
              profileId: "root-profile",
              node: { type: "subproject", id: "pilot-team" },
              initiativeId: "pilot",
            },
          },
        },
        idempotencyKey: "esc-1",
      }),
    ).rejects.toThrow("assignment_permission_ceiling");

    // 2. Unauthorized cross-workspace scope expansion by `pilot-lead` is refused!
    await expect(
      tool.call({
        actor: leadActor,
        arguments: {
          action: "propose",
          key: "cross-project",
          request: {
            id: "bad-plan",
            projectId: "other",
            title: "Unauthorized",
            explanation: "Outside scope",
            changes: [
              {
                kind: "team",
                id: "hack",
                name: "Hack",
                parent: { type: "project", id: "other" },
                why: "Outside",
              },
            ],
          },
        },
        idempotencyKey: "esc-2",
      }),
    ).rejects.toThrow();

    // 3. Freeze (`paused`) stops queued dispatch while urgent initiative gets fresh authority!
    await tool.call({
      actor: leadActor,
      arguments: {
        action: "dispatch",
        key: "dispatch-checklist",
        request: { taskId: "pilot-checklist", planId: "pilot-plan" },
      },
      idempotencyKey: "disp-1",
    });
    expect(f.f.store.record("task", "pilot-checklist")?.planned).toBe(false);

    const freezePlan = (await api(
      "company.propose",
      {
        id: "freeze-and-urgent",
        projectId: "coach",
        title: "Freeze pilot, activate urgent VIP",
        explanation: "Park checklist and focus on VIP bug",
        changes: [
          {
            kind: "initiative",
            value: mkInitiative("pilot", {
              teamId: "pilot-team",
              managerThreadId: "pilot-lead",
              state: "paused",
              version: 2,
            }),
            why: "Freeze launch work",
          },
          {
            kind: "initiative",
            value: mkInitiative("urgent-vip", {
              teamId: "pilot-team",
              managerThreadId: "pilot-lead",
              priority: "urgent",
              state: "active",
            }),
            why: "Urgent VIP fix",
          },
        ],
        authority: {
          initiativeId: "urgent-vip",
          maxTasks: 2,
          permissionCeiling: "workspace_write",
          budgetUsd: 0.5,
        },
      },
      "propose-freeze",
      f.actor,
    )) as CompanyPlan;

    await api(
      "company.decide",
      { id: freezePlan.id, version: 1, baseline: freezePlan.baseline, approve: true },
      "approve-freeze",
    );

    await runner.schedule();
    // Frozen `pilot-checklist` stays queued with holdReason "Initiative paused: ..." and NEVER starts!
    expect(f.f.store.record("task", "pilot-checklist")).toMatchObject({
      state: "queued",
    });
    expect(String(f.f.store.record("task", "pilot-checklist")?.holdReason)).toContain(
      "Initiative paused",
    );

    // 4. Dependency failure holds downstream task; cancellation stops active turn & releases reservation!
    await tool.call({
      actor: leadActor,
      arguments: {
        action: "assign",
        key: "assign-vip-1",
        request: {
          planId: "freeze-and-urgent",
          value: {
            id: "vip-step-1",
            title: "Step 1",
            brief: "Fix VIP",
            profileId: "profile",
            node: { type: "subproject", id: "pilot-team" },
            initiativeId: "urgent-vip",
            accountableThreadId: "pilot-lead",
            budgetUsd: 0.3,
          },
        },
      },
      idempotencyKey: "vip-1",
    });
    await tool.call({
      actor: leadActor,
      arguments: {
        action: "assign",
        key: "assign-vip-2",
        request: {
          planId: "freeze-and-urgent",
          value: {
            id: "vip-step-2",
            title: "Step 2",
            brief: "Verify VIP",
            profileId: "profile",
            node: { type: "subproject", id: "pilot-team" },
            initiativeId: "urgent-vip",
            accountableThreadId: "pilot-lead",
            dependencies: ["vip-step-1"],
            budgetUsd: 0.2,
          },
        },
      },
      idempotencyKey: "vip-2",
    });

    // Plan is now at maxTasks=2, budgetUsd=0.5/0.5 -> a 3rd task fails with task/budget limit.
    await expect(
      tool.call({
        actor: leadActor,
        arguments: {
          action: "assign",
          key: "assign-vip-3",
          request: {
            planId: "freeze-and-urgent",
            value: {
              id: "vip-step-3",
              title: "Step 3",
              brief: "Extra",
              profileId: "profile",
              node: { type: "subproject", id: "pilot-team" },
              initiativeId: "urgent-vip",
              budgetUsd: 0.2,
            },
          },
        },
        idempotencyKey: "vip-3",
      }),
    ).rejects.toThrow("assignment_task_limit");

    await runner.schedule();
    expect(f.f.store.record("task", "vip-step-1")?.state).toBe("running");

    // Seed a running turn on `vip-step-1:thread`, then cancel `vip-step-2` first and verify reservation release,
    // and fail `vip-step-1` to verify dependency failure hold on a replacement downstream task!
    await toolWithInterrupt.call({
      actor: leadActor,
      arguments: {
        action: "cancel",
        key: "cancel-vip-2",
        request: {
          taskId: "vip-step-2",
          reason: "Replace with narrower verification task",
          planId: "freeze-and-urgent",
        },
      },
      idempotencyKey: "can-2",
    });
    expect(f.f.store.record("task", "vip-step-2")?.state).toBe("cancelled");

    // Reservation was released (`vip-step-2`'s slot & $0.20 freed), so `vip-step-2b` now succeeds!
    await tool.call({
      actor: leadActor,
      arguments: {
        action: "assign",
        key: "assign-vip-2b",
        request: {
          planId: "freeze-and-urgent",
          value: {
            id: "vip-step-2b",
            title: "Step 2b",
            brief: "Narrower verification",
            profileId: "profile",
            node: { type: "subproject", id: "pilot-team" },
            initiativeId: "urgent-vip",
            accountableThreadId: "pilot-lead",
            dependencies: ["vip-step-1"],
            budgetUsd: 0.2,
          },
        },
      },
      idempotencyKey: "vip-2b",
    });

    // Fail `vip-step-1` -> `runner.schedule()` holds `vip-step-2b` with `"Blocked by failed dependency: ..."`.
    f.f.store.dispatch("fail-step-1", (s) =>
      finishTaskTurn(
        s,
        "vip-step-1",
        1,
        { status: "failed", text: "", reason: "assertion failed" },
        { commandId: "fail-step-1", at, actor: { kind: "system", id: "test" } },
      ),
    );
    await runner.schedule();
    expect(f.f.store.record("task", "vip-step-2b")?.state).toBe("queued");
    expect(String(f.f.store.record("task", "vip-step-2b")?.holdReason)).toContain(
      "Blocked by failed dependency: vip-step-1",
    );

    // Cancel an actively running task -> interrupts its running turn!
    f.f.store.dispatch("seed-running-turn", (s) =>
      handle(
        s,
        {
          type: "create",
          kind: "turn",
          value: {
            id: "step2b-turn",
            sessionId: "session",
            threadId: "vip-step-2b:thread",
            status: "running",
            origin: "system",
            startedAt: at,
          },
        },
        { commandId: "seed-running-turn", at, actor: { kind: "system", id: "test" } },
      ),
    );
    await toolWithInterrupt.call({
      actor: leadActor,
      arguments: {
        action: "cancel",
        key: "cancel-vip-2b",
        request: { taskId: "vip-step-2b", reason: "Stop downstream work" },
      },
      idempotencyKey: "can-2b",
    });
    expect(interrupted).toEqual(["vip-step-2b:thread:step2b-turn"]);
  } finally {
    runner.close();
    f.f.close();
  }
});
