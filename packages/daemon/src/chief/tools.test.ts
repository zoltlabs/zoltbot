import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { expect, it } from "vitest";
import { chiefProviderToolDefinitions } from "../runtime-tools.js";
import { chiefFragments } from "./digest.js";
import { chiefInstructions } from "./identity.js";
import { at, chiefFixture as setup } from "./test-fixture.js";
import { chiefToolDefinitions, respondChiefApproval } from "./tools.js";

it("gives the chief, and only the chief, its own tools", async () => {
  const { f, tools, actor, change } = await setup();
  try {
    expect(tools.authorize(actor, "chief_overview", {})).toBe(true);
    // Organization shaping is available; unrelated runtime tools remain excluded.
    expect(tools.authorize(actor, "workspace_read", {})).toBe(true);
    expect(tools.authorize(actor, "team_message", {})).toBe(false);
    change({
      type: "update",
      kind: "settings",
      id: "chief.thread",
      changes: { value: "other" },
    });
    expect(tools.authorize(actor, "chief_overview", {})).toBe(false);
  } finally {
    f.close();
  }
});

it("reads every chat with status and keeps notes without asking", async () => {
  const { f, call } = await setup();
  try {
    const overview = await call("chief_overview", {});
    expect(overview.workspaces).toEqual([{ id: "coach", name: "Coach V2", teams: [] }]);
    // Its own thread is never one of the chats it coordinates.
    expect(overview.chats).toEqual([
      expect.objectContaining({ id: "worker", place: "Coach V2", status: "working" }),
    ]);
    expect(await call("chief_overview", { status: "done" })).toMatchObject({ chats: [] });
    expect(await call("chief_read_chat", { chatId: "thread" })).toEqual({
      error: "chat_not_found",
    });
    await call("chief_note", { chatId: "worker", text: "Waiting on the API fix" });
    await call("chief_note", { text: "One chat running; nothing blocked." });
    expect(
      f.store.snapshot(["settings"]).settings?.find((row) => row.key === "chief.notes")?.value,
    ).toMatchObject({
      summary: { text: "One chat running; nothing blocked." },
      chats: { worker: { text: "Waiting on the API fix" } },
    });
    expect(await call("chief_read_chat", { chatId: "worker" })).toMatchObject({
      status: "working",
      note: "Waiting on the API fix",
    });
    expect(f.store.snapshot(["interaction"]).interaction ?? []).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("appends a live status digest to the chief's turns only", async () => {
  const { f, call } = await setup();
  try {
    await call("chief_note", { chatId: "worker", text: "Waiting on the API fix" });
    const [fragment] = chiefFragments(f.store, "thread");
    expect(fragment).toMatchObject({ id: "chief.status", kind: "status" });
    expect(fragment?.text).toContain("Running (1):");
    expect(fragment?.text).toContain(
      '[Coach V2] "Fix onboarding" (worker) | your note: Waiting on the API fix',
    );
    expect(chiefFragments(f.store, "worker")).toEqual([]);
  } finally {
    f.close();
  }
});

it("messages a chat only after approval, and reports the outcome back", async () => {
  const { f, call, pending, queued, wakes, human, context } = await setup();
  try {
    const result = await call("chief_message_chat", {
      key: "nudge",
      chatId: "worker",
      text: "The API fix landed; retry the tests.",
    });
    expect(result).toMatchObject({ status: "pending" });
    expect(queued("worker")).toEqual([]);
    const request = pending(result.interactionId);
    expect(request).toMatchObject({ type: "approval", threadId: "thread", state: "pending" });
    const answer = { action: "accept" as const, choice: "allow_once", by: human, at };
    await respondChiefApproval(context, request, answer);
    expect(queued("worker")).toEqual([
      {
        origin: "agent",
        text: "[Message from Zolt, the user's main agent; the user approved it.]\nThe API fix landed; retry the tests.",
      },
    ]);
    expect(queued("thread").at(-1)?.text).toBe(
      "[Zoltbot] Approved: sent your message to chat worker.",
    );
    expect(wakes).toEqual(["worker", "thread"]);
    // Replaying the answer sends nothing twice.
    await respondChiefApproval(context, request, answer);
    expect(queued("worker")).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("starts a chat with its brief after approval and tells the chief when declined", async () => {
  const { f, call, pending, queued, human, context, change, interrupts } = await setup();
  try {
    change({ type: "create", kind: "settings", value: { key: "chief.name", value: "Atlas" } });
    const started = await call("chief_start_chat", {
      key: "release",
      workspaceId: "coach",
      title: "Release notes",
      brief: "Draft release notes for 2.1.",
    });
    const request = pending(started.interactionId);
    expect(request.title).toBe("Atlas: start a chat");
    await respondChiefApproval(context, request, {
      action: "accept",
      choice: "allow_once",
      by: human,
      at,
    });
    const chat = f.store.snapshot(["thread"]).thread?.find((row) => row.title === "Release notes");
    expect(chat).toMatchObject({ projectId: "coach", node: { type: "project", id: "coach" } });
    expect(queued(String(chat?.id))[0]?.text).toBe(
      "[Brief from Atlas, the user's main agent; the user approved it.]\nDraft release notes for 2.1.",
    );

    const stop = await call("chief_stop_chat", { chatId: "worker" });

    await respondChiefApproval(context, pending(stop.interactionId), {
      action: "decline",
      feedback: "Let it finish",
      by: human,
      at,
    });
    expect(interrupts).toEqual([]);
    expect(queued("thread").at(-1)?.text).toBe(
      '[Zoltbot] The user declined: Stop the running turn in "Fix onboarding". Reason: Let it finish',
    );
    expect(await call("chief_stop_chat", { chatId: "thread" })).toEqual({
      error: "chat_not_found",
    });
  } finally {
    f.close();
  }
});

it("names the agent from the setting", () => {
  expect(chiefInstructions("Atlas")).toMatch(/^You are Atlas, the user's main agent/);
});

it("fits its frozen tools and instructions in the 1500 token fixed launch budget", () => {
  const fixed =
    referenceTokenEstimate(JSON.stringify(chiefProviderToolDefinitions)) +
    referenceTokenEstimate(chiefInstructions("Zolt"));
  expect(fixed).toBeLessThan(1500);
  // The server still validates every call against the full contracts.
  expect(chiefProviderToolDefinitions.map((tool) => tool.name)).toEqual([
    ...chiefToolDefinitions.map((tool) => tool.name),
    "company_work",
  ]);
});

it("distinguishes queued input, held tasks, awaiting review, and accepted work instead of reporting held chats as working", async () => {
  const { f, call, put, change } = await setup();
  const { createTask, finishTaskTurn, handle, holdTask, startTask } = await import("@zoltbot/core");
  let seq = 0;
  const ctx = () => ({
    commandId: `status-check:${++seq}`,
    at: new Date().toISOString(),
    actor: { kind: "human" as const, id: "local-owner" },
  });
  try {
    // End the initial worker turn so it is no longer running.
    put("turn", "worker-turn", { status: "completed", endedAt: at });

    // Create a delegated task bound to `worker` with a queued user brief AND a context_budget_hold.
    f.store.dispatch("create-held-task", (state) =>
      createTask(
        state,
        {
          id: "task-held",
          title: "Fix VIP SLA",
          brief: "Fix SLA routing",
          node: { type: "project", id: "coach" },
          profileId: "profile",
          existingThreadId: "worker",
        },
        ctx(),
      ),
    );
    change({
      type: "create",
      kind: "item",
      value: {
        id: "queued-brief",
        threadId: "worker",
        kind: "user",
        seq: 50,
        body: {
          queueVersion: 1,
          input: [{ type: "text", text: "Fix SLA routing" }],
          mode: "queue",
          queueState: "queued",
        },
        createdAt: at,
        updatedAt: at,
      },
    });
    f.store.dispatch("hold-task", (state) =>
      holdTask(
        state,
        "task-held",
        "context_budget_hold: Optional knowledge (opt) exceeds remaining budget (100 tokens).",
        ctx(),
      ),
    );

    const heldOverview = (await call("chief_overview", {})) as {
      chats: Record<string, unknown>[];
    };
    expect(heldOverview.chats).toEqual([
      expect.objectContaining({
        id: "worker",
        status: "held",
        executionState: "held",
        queuedInputCount: 1,
        taskId: "task-held",
        taskState: "queued",
        holdReason:
          "context_budget_hold: Optional knowledge (opt) exceeds remaining budget (100 tokens).",
        hasSubmittedResult: false,
      }),
    ]);
    const [heldDigest] = chiefFragments(f.store, "thread");
    expect(heldDigest?.text).toContain("Held or blocked (1):");
    expect(heldDigest?.text).not.toContain("Running (1):");

    // Clear the hold while queued input remains -> queued_input, still not "working".
    put("task", "task-held", { holdReason: undefined });
    const queuedOverview = (await call("chief_overview", {})) as {
      chats: Record<string, unknown>[];
    };
    expect(queuedOverview.chats[0]).toMatchObject({
      id: "worker",
      status: "queued",
      executionState: "queued_input",
      queuedInputCount: 1,
    });

    // Start task, deliver queued input, and finish task -> awaiting_review (not accepted yet).
    f.store.dispatch("start-task", (state) => startTask(state, "task-held", 1, ctx()));
    for (const item of f.store.snapshot(["item"]).item ?? []) {
      if (item.threadId === "worker" && item.kind === "user") {
        put("item", String(item.id), {
          body: { ...(item.body as Record<string, unknown>), queueState: "sent" },
        });
      }
    }
    f.store.dispatch("finish-task", (state) =>
      finishTaskTurn(state, "task-held", 1, { status: "completed", text: "Fixed SLA" }, ctx()),
    );
    const reviewOverview = (await call("chief_overview", {})) as {
      chats: Record<string, unknown>[];
    };
    expect(reviewOverview.chats[0]).toMatchObject({
      id: "worker",
      status: "awaiting_review",
      executionState: "awaiting_review",
      taskState: "review",
      hasSubmittedResult: true,
    });
    const [reviewDigest] = chiefFragments(f.store, "thread");
    expect(reviewDigest?.text).toContain("Submitted, awaiting review (not accepted) (1):");

    // Human or authorized independent review accepts -> executionState becomes accepted.
    f.store.dispatch("accept-task", (state) =>
      handle(state, { type: "review", id: "task-held", revision: 1, decision: "accept" }, ctx()),
    );
    const acceptedOverview = (await call("chief_overview", {})) as {
      chats: Record<string, unknown>[];
    };
    expect(acceptedOverview.chats[0]).toMatchObject({
      id: "worker",
      status: "done",
      executionState: "accepted",
      taskState: "completed",
      reviewState: "accepted",
      hasSubmittedResult: true,
    });
  } finally {
    f.close();
  }
});

it("returns matching workspace metadata on scoped chief_overview and delivers authorized handoffs without redundant approvals", async () => {
  const { f, call, actor, context, queued, wakes } = await setup();
  const { companyApi } = await import("../company-api.js");
  const api = companyApi(context);
  try {
    const scopedBefore = await call("chief_overview", { workspaceId: "coach" });
    expect(scopedBefore.workspaces).toEqual([{ id: "coach", name: "Coach V2", teams: [] }]);

    const plan = (await api(
      "company.propose",
      {
        id: "org-plan",
        projectId: "coach",
        title: "Create engineering manager",
        explanation: "Delegate within approved scope",
        changes: [
          {
            kind: "team",
            id: "eng",
            name: "Engineering",
            parent: { type: "project", id: "coach" },
            why: "Own fixes",
          },
          {
            kind: "chat",
            id: "eng-lead",
            title: "Engineering Lead",
            parent: { type: "subproject", id: "eng" },
            profileId: "profile",
            manager: true,
            why: "Coordinate work",
          },
        ],
      },
      "propose-org",
      actor,
    )) as { id: string; version: number; baseline: string };

    await api(
      "company.decide",
      { id: plan.id, version: plan.version, baseline: plan.baseline, approve: true },
      "approve-org",
    );

    // Team-scoped chief_overview also returns the parent workspace with its teams.
    const teamScoped = await call("chief_overview", { workspaceId: "eng" });
    expect(teamScoped.workspaces).toEqual([
      { id: "coach", name: "Coach V2", teams: [{ id: "eng", name: "Engineering" }] },
    ]);

    // Handoff to the approved manager delivers directly without creating a pending interaction!
    const sent = await call("chief_message_chat", {
      key: "handoff-1",
      chatId: "eng-lead",
      text: "Dispatch the planned onboarding fix and report verification.",
    });
    expect(sent).toMatchObject({
      status: "sent",
      chatId: "eng-lead",
      authorityPlanId: "org-plan",
    });
    expect(f.store.snapshot(["interaction"]).interaction ?? []).toHaveLength(0);
    expect(wakes).toContain("eng-lead");
    const agentMessages = () => queued("eng-lead").filter((m) => m.origin === "agent");
    expect(agentMessages()).toHaveLength(1);
    expect(agentMessages()[0]?.text).toContain("under approved plan org-plan");

    // Retrying with the same key is idempotent.
    const retry = await call("chief_message_chat", {
      key: "handoff-1",
      chatId: "eng-lead",
      text: "Dispatch the planned onboarding fix and report verification.",
    });
    expect(retry).toMatchObject({ status: "sent", authorityPlanId: "org-plan" });
    expect(agentMessages()).toHaveLength(1);

    // Messaging an unrelated non-manager chat without a company task still requires human approval!
    const unrelated = await call("chief_message_chat", {
      key: "nudge-worker",
      chatId: "worker",
      text: "Unapproved side message",
    });
    expect(unrelated).toMatchObject({ status: "pending" });
    expect(f.store.snapshot(["interaction"]).interaction ?? []).toHaveLength(1);
  } finally {
    f.close();
  }
});
