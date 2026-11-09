import { handle } from "@zoltbot/core";
import { type Orchestration, OrchestrationSchema, parse, parseEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "../private-input.js";
import { orchestrationService } from "./service.js";

it("routes ordinary project chat without manager setup, preserves receipts, and updates future phase models", async () => {
  const f = await runtimeFixture();
  const context = (commandId: string) => ({
    commandId,
    at,
    actor: { kind: "human" as const, id: "owner" },
  });
  f.store.dispatch("project", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "project",
        value: {
          id: "p",
          name: "Project",
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
      context("project"),
    ),
  );
  for (const [kind, id, changes] of [
    ["thread", "thread", { projectId: "p" }],
    ["agent", "profile", { permissionProfile: "workspace_write" }],
  ] as const)
    f.store.dispatch(`bind:${kind}`, (state) =>
      handle(
        state,
        { type: "update", kind, id, changes, confirmed: true },
        context(`bind:${kind}`),
      ),
    );
  let inferenceCalls = 0;
  let routed = false;
  let routerOnline = true;
  let brokenRouter = false;
  let followAction = "update";
  const forwarded: string[] = [];
  let service: ReturnType<typeof orchestrationService>;
  const events: unknown[] = [];
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  service = orchestrationService({
    store: f.store,
    privacy,
    publish(batch) {
      events.push(...batch);
      service?.observe(batch);
    },
    async schedule() {},
    async prepare() {},
    async cancel() {},
    async forward(_threadId, _input, commandId) {
      forwarded.push(commandId);
      if (forwarded.length === 1) throw Error("delivery_uncertain");
    },
    async router() {
      if (!routerOnline) return undefined;
      return {
        model: "cheap",
        entries: [
          {
            definitionId: "fake",
            models: [
              { id: "sol", label: "Sol", efforts: ["high"] },
              { id: "astra", label: "Astra", efforts: ["high"] },
            ],
          },
        ],
        adapter: {
          async listModels() {
            return [];
          },
          async stream(request) {
            inferenceCalls++;
            if (brokenRouter) throw Error("routing_inference_failed");
            expect(request.conversationId).toMatch(/^router-/);
            if (request.instructions.includes("follow-up"))
              request.onText(
                JSON.stringify({
                  action: followAction,
                  role: "tests",
                  model: "astra",
                  effort: "high",
                }),
              );
            else
              request.onText(
                JSON.stringify(
                  routed
                    ? {
                        intent: "phased_task",
                        phases: [
                          { role: "plan", instruction: "Plan" },
                          { role: "tests", instruction: "Test" },
                        ],
                      }
                    : { intent: "chat", phases: [] },
                ),
              );
            return {};
          },
        },
      };
    },
  });
  try {
    const params = {
      threadId: "thread",
      input: [{ type: "text", text: "How does this work?" }],
      mode: "queue",
    };
    expect(await service.api("turn.send", params, "chat")).toBeUndefined();
    expect(f.store.snapshot(["orchestration"]).orchestration ?? []).toHaveLength(0);
    routed = true;
    const build = { ...params, input: [{ type: "text", text: "Build a feature" }] };
    const first = await service.api("turn.send", build, "build");
    expect(first).toMatchObject({ disposition: "handled" });
    expect(await service.api("turn.send", build, "build")).toEqual(first);
    expect(inferenceCalls).toBe(2);
    await service.start();
    const latest = () =>
      parse(OrchestrationSchema, f.store.snapshot(["orchestration"]).orchestration?.[0]);
    expect(latest().phases[0]?.taskId).toBeDefined();
    await service.api(
      "turn.send",
      { ...params, input: [{ type: "text", text: "Use Astra high for tests" }] },
      "update",
    );
    expect(latest().phases[1]?.execution).toMatchObject({ model: "astra", effort: "high" });
    expect(latest().phases[0]?.execution.model).toBe("sol");
    followAction = "feedback";
    const feedback = { ...params, input: [{ type: "text", text: "Adjust the plan" }] };
    await expect(service.api("turn.send", feedback, "feedback")).rejects.toThrow(
      "delivery_uncertain",
    );
    const callsBeforeRetry = inferenceCalls;
    await service.api("turn.send", feedback, "feedback");
    expect(inferenceCalls).toBe(callsBeforeRetry);
    expect(forwarded).toEqual(["feedback:forward", "feedback:forward"]);
    followAction = "update";
    const saved: Orchestration = latest();
    const commandId = "block";
    f.store.dispatch(commandId, () => ({
      events: [
        parseEvent({
          eventId: commandId,
          commandId,
          aggregateType: "orchestration",
          aggregateId: saved.id,
          type: "orchestration.updated",
          occurredAt: at,
          payload: { ...saved, state: "blocked", revision: saved.revision + 1 },
        }),
      ],
      result: {},
    }));
    expect(events.length).toBeGreaterThan(0);
    await expect(
      service.api("turn.send", { ...build, mode: "steer" }, "steer-active"),
    ).rejects.toThrow("active_phase_required");
    await service.api(
      "orchestration.cancel",
      { id: latest().id, revision: latest().revision },
      "cancel",
    );
    routerOnline = false;
    await expect(
      service.api(
        "turn.send",
        { ...build, input: [{ type: "text", text: "Use Sol for planning" }] },
        "offline-explicit",
      ),
    ).rejects.toThrow("router_connection_required");
    routerOnline = true;
    brokenRouter = true;
    expect(await service.api("turn.send", params, "failed-router-question")).toBeUndefined();
    await expect(service.api("turn.send", build, "failed-router-build")).rejects.toThrow(
      "routing_inference_failed",
    );
    await expect(
      service.api("turn.send", { ...build, input: [{ type: "text", text: "different" }] }, "build"),
    ).rejects.toThrow("command_receipt_conflict");
  } finally {
    await service.close();
    f.close();
  }
});

it("runs chat through real task/session scheduling across providers, repairs findings, and verifies tests", async () => {
  const { PhaseFakeSession } = await import("../../../../tools/fakes/src/orchestration-runtime.js");
  const { SessionManager } = await import("../session-manager.js");
  const { taskRunner } = await import("../task-runner.js");
  const f = await runtimeFixture();
  const ctx = (commandId: string) => ({
    commandId,
    at,
    actor: { kind: "human" as const, id: "owner" },
  });
  f.store.dispatch("p", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "project",
        value: {
          id: "p",
          name: "Project",
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
      ctx("p"),
    ),
  );
  for (const [kind, id, changes] of [
    ["thread", "thread", { projectId: "p" }],
    ["agent", "profile", { permissionProfile: "workspace_write" }],
  ] as const)
    f.store.dispatch(`bind:${kind}`, (state) =>
      handle(state, { type: "update", kind, id, changes, confirmed: true }, ctx(`bind:${kind}`)),
    );
  f.store.dispatch("other", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "agentDefinition",
        value: { ...f.store.record("agentDefinition", "fake"), id: "other" },
      },
      ctx("other"),
    ),
  );
  f.store.dispatch("workspace", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "workspace",
        value: {
          id: "w",
          projectId: "p",
          kind: "worktree",
          path: f.root,
          state: "active",
          createdAt: at,
        },
      },
      ctx("workspace"),
    ),
  );
  let tasks: ReturnType<typeof taskRunner> | undefined;
  let service: ReturnType<typeof orchestrationService> | undefined;
  const publish = (events: import("@zoltbot/protocol").DomainEvent[]) => {
    tasks?.observe(events);
    service?.observe(events);
  };
  const privacy = new PrivateInputGuard({ store: f.store, publish });
  const launched: {
    role: string;
    model: string | undefined;
    definition: string;
    permission: string;
    prompt: string;
  }[] = [];
  let reviews = 0;
  const manager = new SessionManager({
    store: f.store,
    publish,
    host: {
      async prepare(input) {
        return {
          cwd: f.root,
          estimate: (value) => value.length,
          ...(input.profile.model ? { model: input.profile.model } : {}),
          async open() {
            const native = new PhaseFakeSession(input.thread.id);
            native.send = async (value) => {
              const role = input.thread.title.split(":")[0] ?? "";
              launched.push({
                role,
                model: input.profile.model,
                definition: input.definition.id,
                permission: input.profile.permissionProfile,
                prompt: JSON.stringify(value),
              });
              const turnId = `${input.thread.id}:turn`;
              await native.eventsQueue.push({ t: "turn.started", turnId });
              if (role === "tests") {
                await native.eventsQueue.push({
                  t: "tool.started",
                  turnId,
                  itemId: "tests",
                  name: "Shell",
                  kind: "execute",
                  input: { command: "pnpm test" },
                });
                await native.eventsQueue.push({
                  t: "tool.done",
                  itemId: "tests",
                  status: "ok",
                  output: "3 tests passed",
                });
              }
              const blocked = role === "review" && reviews++ === 0;
              await native.eventsQueue.push({
                t: "message.done",
                turnId,
                itemId: "answer",
                phase: "final",
                text: blocked
                  ? "Fix input validation [ZOLTBOT_PHASE:blocked]"
                  : `${role} succeeded [ZOLTBOT_PHASE:passed]`,
              });
              await native.eventsQueue.push({ t: "turn.done", turnId, status: "completed" });
              return { disposition: "started", id: turnId };
            };
            return native;
          },
        };
      },
    },
  });
  tasks = taskRunner({
    store: f.store,
    publish,
    checkPublic: (value) => privacy.prepareData(value),
    startInSession: true,
    preflight: (id) => manager.preflight(id),
    wake: async (id) => {
      (await manager.ensure(id)).wake();
    },
  });
  service = orchestrationService({
    store: f.store,
    privacy,
    publish,
    schedule: () => tasks?.schedule() ?? Promise.resolve(),
    async cancel() {},
    async prepare(id) {
      const task = f.store.record("task", id);
      if (!task?.workspaceId)
        f.store.dispatch(`bind:${id}`, () => ({
          result: {},
          events: [
            parseEvent({
              eventId: `bind:${id}`,
              aggregateType: "task",
              aggregateId: id,
              type: "task.updated",
              occurredAt: at,
              payload: { ...task, workspaceId: "w" },
            }),
          ],
        }));
    },
    async router() {
      return {
        model: "router",
        entries: [
          { definitionId: "fake", models: [{ id: "sol", label: "Sol" }] },
          { definitionId: "other", models: [{ id: "opus", label: "Opus" }] },
        ],
        adapter: {
          async listModels() {
            return [];
          },
          async stream(request) {
            request.onText(
              JSON.stringify({
                intent: "phased_task",
                phases: ["plan", "implement", "review", "tests"].map((role) => ({
                  role,
                  instruction: role,
                  model: role === "review" ? "opus" : "sol",
                })),
              }),
            );
            return {};
          },
        },
      };
    },
  });
  const latest = () =>
    parse(OrchestrationSchema, f.store.snapshot(["orchestration"]).orchestration?.[0]);
  async function until(state: string) {
    for (let i = 0; i < 300; i++) {
      if (latest().state === state) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error(`run_did_not_reach_${state}: ${JSON.stringify(latest())}`);
  }
  try {
    await service.api(
      "turn.send",
      { threadId: "thread", mode: "queue", input: [{ type: "text", text: "Build this feature" }] },
      "build",
    );
    await until("blocked");
    expect(launched.map((phase) => phase.role)).toEqual(["plan", "implement", "review"]);
    await service.api(
      "orchestration.repair",
      { id: latest().id, revision: latest().revision },
      "repair",
    );
    await until("completed");
    expect(launched.map((phase) => phase.role)).toEqual([
      "plan",
      "implement",
      "review",
      "implement",
      "review",
      "tests",
    ]);
    expect(launched.find((phase) => phase.role === "review")).toMatchObject({
      definition: "other",
      model: "opus",
      permission: "read_only",
    });
    expect(launched[3]?.prompt).toContain("Fix input validation");
    expect(
      f.store
        .snapshot(["item"])
        .item?.some((item) => item.threadId === "thread" && item.kind === "message"),
    ).toBe(true);
  } finally {
    await service.close();
    tasks.close();
    await manager.close();
    f.close();
  }
});
