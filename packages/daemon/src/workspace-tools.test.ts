import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { type Command, expireInteractions, handle } from "@zoltbot/core";
import { HOST_WORKSPACE_REF, type Interaction, InteractionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "./private-input.js";
import { recover } from "./recovery.js";
import { runtimeToolDefinitions, runtimeTools } from "./runtime-tools.js";
import { respondWorkspaceApproval } from "./workspace-tools.js";

async function setup() {
  const f = await runtimeFixture();
  let n = 0;
  const change = (command: Command) => {
    const commandId = `change:${++n}`;
    f.store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  const project = (id: string, name: string, hierarchyDepth: number) =>
    change({
      type: "create",
      kind: "project",
      value: {
        id,
        name,
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      },
    });
  project("zolt", "Zolt", 1);
  project("other", "Other", 1);
  change({
    type: "update",
    kind: "thread",
    id: "thread",
    changes: { kind: "manager", projectId: "zolt", node: { type: "project", id: "zolt" } },
  });
  change({ type: "transition", kind: "session", id: "session", to: "ready" });
  change({ type: "transition", kind: "session", id: "session", to: "running" });
  change({
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  const wakes: string[] = [];
  const context = {
    store: f.store,
    privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
    publish() {},
    async wake(threadId: string) {
      wakes.push(threadId);
    },
  };
  const tools = runtimeTools(context, { waitMs: 0 });
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  let calls = 0;
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.tools.get(name);
    if (!tool) throw new Error("missing_tool");
    return tool({ actor, arguments: args, idempotencyKey: `call:${++calls}` }) as Promise<
      Record<string, unknown>
    >;
  };
  const pending = (id: unknown) =>
    parse(
      InteractionSchema,
      f.store.snapshot(["interaction"]).interaction?.find((row) => row.id === id),
    );
  return { f, change, context, tools, actor, call, wakes, pending };
}

it("creates in scope directly, retries by key and refuses scopes outside the manager's", async () => {
  const { f, tools, actor, call, change } = await setup();
  try {
    const view = await call("workspace_read", {});
    expect(view.projects).toEqual([{ id: "zolt", name: "Zolt", depth: 1, editable: true }]);
    const args = {
      key: "growth",
      kind: "subproject",
      name: "Growth",
      parent: { type: "project", id: "zolt" },
    };
    const area = await call("workspace_create", args);
    expect(area).toMatchObject({ status: "done", kind: "subproject" });
    const seq = f.store.lastSeq();
    expect(await call("workspace_create", args)).toEqual(area);
    expect(f.store.lastSeq()).toBe(seq);
    await expect(call("workspace_create", { ...args, name: "Changed" })).rejects.toThrow(
      "command_receipt_conflict",
    );
    const chat = await call("workspace_create", {
      key: "chat",
      kind: "chat",
      name: "Pricing",
      parent: { type: "subproject", id: area.id },
    });
    expect(f.store.snapshot(["thread"]).thread?.find((row) => row.id === chat.id)).toMatchObject({
      kind: "side",
      projectId: "zolt",
      node: { type: "subproject", id: area.id },
    });
    await call("workspace_update", {
      key: "rename",
      target: { type: "subproject", id: area.id },
      changes: { name: "Growth loops" },
    });
    expect(
      f.store.snapshot(["subproject"]).subproject?.find((row) => row.id === area.id)?.name,
    ).toBe("Growth loops");
    await expect(
      call("workspace_create", {
        key: "elsewhere",
        kind: "subproject",
        name: "Nope",
        parent: { type: "project", id: "other" },
      }),
    ).rejects.toThrow("outside_workspace_scope");
    expect(
      f.store.snapshot(["audit"]).audit?.filter((row) => row.action === "workspace.create").length,
    ).toBe(2);
    change({ type: "update", kind: "thread", id: "thread", changes: { kind: "main" } });
    expect(tools.authorize(actor, "workspace_read", {})).toBe(false);
  } finally {
    f.close();
  }
});

it("gates new projects, deeper levels, managers and profile changes on a human approval", async () => {
  const { f, call, pending, context, wakes } = await setup();
  try {
    const deeper = await call("workspace_create", {
      key: "deep",
      kind: "subproject",
      name: "Growth",
      parent: { type: "project", id: "zolt" },
    });
    expect(deeper.status).toBe("done");
    expect(
      await call("workspace_create", {
        key: "deeper",
        kind: "subproject",
        name: "Onboarding",
        parent: { type: "subproject", id: deeper.id },
      }),
    ).toMatchObject({ status: "pending", reasons: ["deeper_hierarchy"] });
    expect(
      await call("workspace_create", {
        key: "lead",
        kind: "chat",
        name: "Lead",
        parent: { type: "subproject", id: deeper.id },
        manager: true,
      }),
    ).toMatchObject({ status: "pending", reasons: ["manager_assignment"] });
    expect(
      await call("workspace_update", {
        key: "widen",
        target: { type: "profile", id: "profile" },
        changes: { permissionProfile: "full_access" },
      }),
    ).toMatchObject({ status: "pending", reasons: ["profile_change"] });
    const args = { key: "coach", kind: "project", name: "Coach" };
    const first = await call("workspace_create", args);
    expect(first).toMatchObject({ status: "pending", reasons: ["new_project"] });
    expect(await call("workspace_create", args)).toEqual(first);
    const request: Interaction = pending(first.interactionId);
    expect(request).toMatchObject({ nativeRef: HOST_WORKSPACE_REF, state: "pending" });
    expect(request.turnId).toBeUndefined();
    expect(f.store.snapshot(["project"]).project).toHaveLength(2);

    // Turn end, process death and daemon restart keep host approvals pending.
    f.store.dispatch("expire", (state) =>
      expireInteractions(state, ["thread"], "process_died", {
        commandId: "expire",
        at,
        actor: { kind: "system", id: "test" },
      }),
    );
    recover(f.store, "boot");
    expect(pending(first.interactionId).state).toBe("pending");

    const answer = {
      action: "accept" as const,
      choice: "allow_once",
      by: { kind: "human" as const, id: "owner" },
      at,
    };
    await respondWorkspaceApproval(context, request, answer);
    const created = f.store.snapshot(["project"]).project?.find((row) => row.name === "Coach");
    expect(created).toMatchObject({ hierarchyDepth: 0 });
    expect(
      f.store
        .snapshot(["audit"])
        .audit?.find((row) => row.action === "workspace.create" && row.target === created?.id),
    ).toMatchObject({
      actor: { kind: "human" },
      detail: { interactionId: request.id, confirmed: true, requestedBy: "profile" },
    });
    const queued = f.store
      .snapshot(["item"])
      .item?.filter((row) => JSON.stringify(row.body).includes("[Zoltbot]"));
    expect(queued).toHaveLength(1);
    expect(wakes).toEqual(["thread"]);
    // Replaying the same answer neither duplicates the project nor the message.
    await respondWorkspaceApproval(context, request, answer);
    expect(f.store.snapshot(["project"]).project).toHaveLength(3);

    const widen = pending(
      f.store
        .snapshot(["interaction"])
        .interaction?.find(
          (row) =>
            (row.context as { toolName?: string } | undefined)?.toolName === "workspace_update",
        )?.id,
    );
    await respondWorkspaceApproval(context, widen, {
      action: "decline",
      feedback: "Keep it read only",
      by: { kind: "human", id: "owner" },
      at,
    });
    expect(
      f.store.snapshot(["agent"]).agent?.find((row) => row.id === "profile")?.permissionProfile,
    ).toBe("read_only");
    expect(
      f.store
        .snapshot(["item"])
        .item?.some((row) => JSON.stringify(row.body).includes("declined. Reason: Keep it")),
    ).toBe(true);
    await expect(
      respondWorkspaceApproval(context, widen, { ...answer, by: { kind: "system", id: "rules" } }),
    ).rejects.toThrow("human_answer_required");
  } finally {
    f.close();
  }
});

it("keeps private values out and fits the injection budget", async () => {
  const { f, call, context } = await setup();
  try {
    context.privacy.remember("synthetic-private-credential");
    await expect(
      call("workspace_create", {
        key: "secret",
        kind: "subproject",
        name: "synthetic-private-credential",
        parent: { type: "project", id: "zolt" },
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(f.store.snapshot())).not.toContain("synthetic-private-credential");
    expect(
      referenceTokenEstimate(runtimeToolDefinitions.map((tool) => tool.description).join("\n")),
    ).toBeLessThan(700);
  } finally {
    f.close();
  }
});
