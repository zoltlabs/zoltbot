import { staffAllowanceKey } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { applyEvents, type DomainState } from "./projectors.js";
import { allowanceCovers, planStaffChange, readStaffAllowance } from "./staff.js";
import { applyStaffChange, setStaffAllowance } from "./staff-apply.js";

const at = "2026-11-19T12:00:00Z";
const team = (id: string, name: string) => ({
  id,
  projectId: "co",
  name,
  label: "Team",
  goal: "",
  instructions: "",
  depth: 1,
  archived: false,
  createdAt: at,
});
const chat = (id: string, kind: string, node: string, agentId = "writer") => ({
  id,
  agentId,
  projectId: "co",
  node: node === "co" ? { type: "project", id: "co" } : { type: "subproject", id: node },
  kind,
  title: id[0]?.toUpperCase() + id.slice(1),
  titleSource: "human",
  pinned: false,
  archived: false,
  createdAt: at,
  lastActivityAt: at,
});
const profile = (id: string, permissionProfile = "workspace_write", model = "sonnet") => ({
  id,
  name: id,
  avatar: "A",
  kind: "profile",
  definitionId: "claude",
  model,
  permissionProfile,
  instructions: "",
  hidden: false,
  archived: false,
});
const task = (id: string, threadId: string, state: string, ownerAgentId = "writer") => ({
  id,
  projectId: "co",
  node: { type: "subproject", id: "pay" },
  rootId: id,
  title: `Task ${id}`,
  brief: "Do it",
  acceptance: "",
  expectedDeliverable: "",
  ownerAgentId,
  threadId,
  accountableThreadId: "payments",
  workspaceMode: "shared",
  state,
  revision: 1,
  attempt: 1,
  maxAttempts: 1,
  reviewRequired: true,
  executionLocation: "local_host",
  createdBy: { kind: "human", id: "owner" },
  createdAt: at,
  updatedAt: at,
});
function company(): DomainState {
  return {
    agent: [profile("writer"), profile("mira-p"), profile("wide", "full_access")],
    project: [
      {
        id: "co",
        name: "Company",
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
    ],
    subproject: [team("pay", "Payments"), team("sales", "Sales")],
    thread: [
      chat("ceo", "manager", "co"),
      chat("payments", "manager", "pay"),
      chat("sales", "manager", "sales"),
      chat("mira", "side", "pay", "mira-p"),
      chat("theo", "side", "pay"),
      chat("kai", "side", "sales"),
    ],
    task: [],
    turn: [],
    settings: [],
  } as unknown as DomainState;
}
const manager = { agentId: "writer", threadId: "payments" };
const ctx = (id: string, kind: "agent" | "human" = "agent") => ({
  commandId: id,
  at,
  actor: kind === "agent" ? { kind, id: "writer" } : { kind, id: "local-owner" },
});
const add = (overrides: Record<string, unknown> = {}) => ({
  kind: "add" as const,
  name: "Quinn",
  role: "QA for refunds",
  model: "sonnet",
  folders: ["tests/payments"],
  ...overrides,
});
const run = (state: DomainState, outcome: { events: unknown[] }) =>
  applyEvents(state, outcome.events as Parameters<typeof applyEvents>[1]);

describe("staff authorization", () => {
  it("lets a manager ask within its team and refuses others", () => {
    const state = company();
    expect(planStaffChange(state, manager, add()).reasons).toEqual(["new_employee"]);
    expect(() => planStaffChange(state, manager, { kind: "archive", threadId: "kai" })).toThrow(
      "staff_outside_scope",
    );
    expect(() => planStaffChange(state, { agentId: "writer", threadId: "theo" }, add())).toThrow(
      "staff_scope_required",
    );
    expect(() =>
      planStaffChange(state, manager, { kind: "archive", threadId: "payments" }),
    ).toThrow("cannot_archive_self");
    expect(() => planStaffChange(state, manager, { kind: "change", threadId: "theo" })).toThrow(
      "no_staff_change",
    );
  });

  it("never applies an agent's request without a human approval", () => {
    const state = company();
    expect(() => applyStaffChange(state, manager, add(), "quinn", ctx("a"))).toThrow(
      "approval_required",
    );
    expect(() =>
      applyStaffChange(state, manager, { kind: "archive", threadId: "theo" }, "x", ctx("b")),
    ).toThrow("approval_required");
    // An approval answered by an agent is not an approval.
    expect(() =>
      applyStaffChange(state, manager, add(), "quinn", ctx("c"), { interactionId: "i" }),
    ).toThrow("approval_required");
  });

  it("adds the employee, its first task and the offered allowance on approval", () => {
    const state = company();
    const plan = planStaffChange(
      state,
      manager,
      add({ firstTask: { title: "Refund tests", brief: "Cover refunds" } }),
    );
    expect(plan.preview.allowanceOffer).toEqual({
      max: 2,
      models: ["sonnet"],
      folders: ["tests/payments"],
    });
    const next = run(
      state,
      applyStaffChange(
        state,
        manager,
        add({ firstTask: { title: "Refund tests", brief: "Cover refunds" } }),
        "quinn",
        ctx("approve", "human"),
        { interactionId: "i-1", grantAllowance: true },
      ),
    );
    const chatRow = next.thread?.find((r) => r.id === "quinn");
    expect(chatRow).toMatchObject({ kind: "side", agentId: "quinn-profile", title: "Quinn" });
    expect(next.agent?.find((r) => r.id === "quinn-profile")?.instructions).toContain(
      "Edit files only in: tests/payments.",
    );
    expect(next.task?.find((r) => r.id === "quinn-task")).toMatchObject({
      threadId: "quinn",
      accountableThreadId: "payments",
      state: "queued",
    });
    expect(readStaffAllowance(next, "payments")).toMatchObject({ max: 2, used: 0 });
    expect(next.audit?.some((r) => r.action === "staff.add")).toBe(true);
  });

  it("refuses wider permissions from the allowance offer", () => {
    const plan = planStaffChange(company(), manager, add({ profileId: "wide" }));
    expect(plan.reasons).toEqual(["new_employee", "permission_widening", "wide_permission"]);
    expect(plan.preview.allowanceOffer).toBeUndefined();
  });
});

describe("standing allowance", () => {
  const granted = (overrides: Record<string, unknown> = {}) => {
    const state = company();
    state.settings = [
      {
        key: staffAllowanceKey("payments"),
        value: {
          threadId: "payments",
          projectId: "co",
          max: 1,
          used: 0,
          models: ["sonnet"],
          folders: ["tests"],
          revision: 1,
          grantedAt: at,
          updatedAt: at,
          ...overrides,
        },
      },
    ];
    return state;
  };

  it("adds without asking up to the cap, then asks again", () => {
    const state = granted();
    expect(planStaffChange(state, manager, add()).reasons).toEqual([]);
    const next = run(state, applyStaffChange(state, manager, add(), "quinn", ctx("add-1")));
    expect(next.thread?.some((r) => r.id === "quinn")).toBe(true);
    expect(readStaffAllowance(next, "payments")?.used).toBe(1);
    expect(planStaffChange(next, manager, add({ name: "Rae" })).reasons).toEqual(["new_employee"]);
  });

  it("covers only listed models, folders inside listed folders and its own project", () => {
    const state = granted();
    expect(planStaffChange(state, manager, add({ model: "opus" })).reasons).toEqual([
      "new_employee",
    ]);
    expect(planStaffChange(state, manager, add({ folders: ["src"] })).reasons).toEqual([
      "new_employee",
    ]);
    expect(planStaffChange(state, manager, add({ folders: [] })).reasons).toEqual(["new_employee"]);
    expect(
      allowanceCovers(readStaffAllowance(state, "payments"), "other", "sonnet", ["tests"]),
    ).toBe(false);
    // Another manager's allowance never covers this one.
    expect(planStaffChange(granted({ threadId: "sales" }), manager, add()).reasons).toEqual([
      "new_employee",
    ]);
  });

  it("is set and turned off only by the owner", () => {
    const state = company();
    expect(() => setStaffAllowance(state, { threadId: "payments", max: 2 }, ctx("set"))).toThrow(
      "human_approval_required",
    );
    const next = run(
      state,
      setStaffAllowance(state, { threadId: "payments", max: 2 }, ctx("set", "human")),
    );
    expect(readStaffAllowance(next, "payments")).toMatchObject({ max: 2, models: [], folders: [] });
    // Empty lists mean any model and no folder limit.
    expect(planStaffChange(next, manager, add({ folders: [] })).reasons).toEqual([]);
    const off = run(
      next,
      setStaffAllowance(next, { threadId: "payments", max: 0 }, ctx("off", "human")),
    );
    expect(planStaffChange(off, manager, add()).reasons).toEqual(["new_employee"]);
    expect(() => setStaffAllowance(state, { threadId: "theo", max: 1 }, ctx("x", "human"))).toThrow(
      "manager_unavailable",
    );
  });
});

describe("archiving one employee", () => {
  it("moves queued tasks to the named teammate and archives at once when idle", () => {
    const state = company();
    state.thread?.push({ ...chat("mira-task", "task", "pay", "mira-p"), taskId: "t2" });
    state.task = [
      task("t1", "mira", "queued", "mira-p"),
      task("t2", "mira-task", "queued", "mira-p"),
    ];
    const plan = planStaffChange(state, manager, {
      kind: "archive",
      threadId: "mira",
      moveTo: "theo",
    });
    expect(plan.preview.moves).toEqual([
      { taskId: "t1", title: "Task t1", to: "Theo" },
      { taskId: "t2", title: "Task t2", to: "Theo" },
    ]);
    const next = run(
      state,
      applyStaffChange(
        state,
        manager,
        { kind: "archive", threadId: "mira", moveTo: "theo" },
        "arch",
        ctx("ok", "human"),
        {
          interactionId: "i-2",
        },
      ),
    );
    const t1 = next.task?.find((r) => r.id === "t1");
    const t2 = next.task?.find((r) => r.id === "t2");
    expect(t1).toMatchObject({ threadId: "theo", ownerAgentId: "writer", state: "queued" });
    // Theo's chat now holds t1, so t2 gets a chat of its own run by Theo's profile.
    expect(t2).toMatchObject({ ownerAgentId: "writer", state: "queued" });
    expect(next.thread?.find((r) => r.id === t2?.threadId)).toMatchObject({
      kind: "task",
      agentId: "writer",
    });
    expect(next.thread?.find((r) => r.id === "mira-task")?.archived).toBe(true);
    expect(next.thread?.find((r) => r.id === "mira")?.archived).toBe(true);
    // The teammate hears about it; history stays in the archived chat.
    expect(
      next.item?.some(
        (r) => r.threadId === "theo" && JSON.stringify(r.body).includes("Mira was archived"),
      ),
    ).toBe(true);
  });

  it("lets running work finish first and sends queued work back to the manager", () => {
    const state = company();
    state.task = [task("run", "mira", "running", "mira-p")];
    state.thread?.push({ ...chat("mira-q", "task", "pay", "mira-p"), taskId: "q" });
    state.task.push(task("q", "mira-q", "queued", "mira-p"));
    state.turn = [{ id: "turn", threadId: "mira", sessionId: "s", status: "running" }];
    const plan = planStaffChange(state, undefined, { kind: "archive", threadId: "mira" });
    expect(plan.reasons).toEqual([]);
    expect(plan.preview.running).toBe(2);
    const next = run(
      state,
      applyStaffChange(
        state,
        undefined,
        { kind: "archive", threadId: "mira" },
        "arch",
        ctx("own", "human"),
      ),
    );
    expect(next.thread?.find((r) => r.id === "mira")).toMatchObject({
      archived: false,
      archiveWhenIdle: true,
    });
    expect(next.task?.find((r) => r.id === "run")).toMatchObject({
      threadId: "mira",
      state: "running",
    });
    expect(next.task?.find((r) => r.id === "q")).toMatchObject({ threadId: "payments" });
  });

  it("hands a manager's accountability to the destination and refuses initiative owners", () => {
    const state = company();
    state.task = [
      { ...task("d", "theo", "queued"), accountableThreadId: "mira" },
      { ...task("e", "kai", "running"), accountableThreadId: "mira" },
    ];
    const next = run(
      state,
      applyStaffChange(
        state,
        undefined,
        { kind: "archive", threadId: "mira" },
        "arch",
        ctx("own", "human"),
      ),
    );
    expect(next.task?.find((r) => r.id === "d")?.accountableThreadId).toBe("payments");
    expect(next.task?.find((r) => r.id === "e")).toMatchObject({
      accountableThreadId: "mira",
      pendingAccountableThreadId: "payments",
    });
    const owner = company();
    owner.initiativeRecord = [
      { id: "i", projectId: "co", managerThreadId: "mira", state: "active" },
    ];
    expect(() => planStaffChange(owner, undefined, { kind: "archive", threadId: "mira" })).toThrow(
      "employee_owns_initiative",
    );
  });
});

describe("changing an employee", () => {
  it("shows a before-and-after diff and keeps a shared profile's name", () => {
    const state = company();
    const request = {
      kind: "change" as const,
      threadId: "theo",
      name: "Theodore",
      model: "opus",
      instructions: "Own the refunds API.",
    };
    const plan = planStaffChange(state, manager, request);
    expect(plan.reasons).toEqual(["profile_change"]);
    expect(plan.preview.fields).toEqual([
      { label: "Name", before: "Theo", after: "Theodore" },
      { label: "Model", before: "sonnet", after: "opus" },
      { label: "Instructions", after: "Own the refunds API." },
    ]);
    expect(plan.preview.sharedWith).toBe(4);
    const next = run(state, applyStaffChange(state, undefined, request, "c", ctx("own", "human")));
    expect(next.thread?.find((r) => r.id === "theo")?.title).toBe("Theodore");
    expect(next.agent?.find((r) => r.id === "writer")).toMatchObject({
      name: "writer",
      model: "opus",
    });
  });
});

describe("hiring from a template", () => {
  it("fills the role and instructions and shows the template on the card", () => {
    const state = company();
    const request = add({ role: "", templateId: "qa-tester" });
    const plan = planStaffChange(state, manager, request);
    expect(plan.preview.fields[0]).toEqual({ label: "From template", after: "QA tester" });
    expect(plan.preview.fields).toContainEqual({
      label: "Role",
      after: "Finds bugs before people do",
    });
    const next = run(
      state,
      applyStaffChange(state, manager, request, "quinn", ctx("approve", "human"), {
        interactionId: "i-1",
      }),
    );
    const hired = next.agent?.find((r) => r.id === "quinn-profile");
    expect(hired).toMatchObject({
      templateId: "qa-tester",
      roleText: "Finds bugs before people do",
    });
    expect(hired?.instructions).toContain("You test the product");
  });

  it("refuses unknown templates, and templates not meant for managers", () => {
    const state = company();
    expect(() => planStaffChange(state, manager, add({ templateId: "nope" }))).toThrow(
      "agent_template_unavailable",
    );
    expect(() => planStaffChange(state, manager, add({ templateId: "bookkeeper" }))).toThrow(
      "agent_template_unavailable",
    );
    expect(() =>
      planStaffChange(state, undefined, add({ templateId: "bookkeeper", teamId: "pay" })),
    ).not.toThrow();
  });
});
