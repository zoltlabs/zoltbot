import { handle } from "@zoltbot/core";
import { type Interaction, type InteractionAnswer, parseEvent } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { interactionApi } from "../interaction-api.js";
import { InteractionEngine } from "../interaction-engine.js";
import { callView, type ViewActions } from "./actions.js";
import { viewFixture } from "./test-fixture.js";

const at = "2026-01-01T00:00:00Z";
async function setup(type: Interaction["type"] = "approval") {
  const f = await viewFixture();
  for (const [kind, value] of [
    [
      "agentDefinition",
      {
        id: "fake",
        displayName: "Fake",
        adapter: "acp",
        binaryNames: [],
        versionCommand: [],
        launch: { command: "fake", args: [], env: {} },
        testedVersions: "1.0.0",
        defaults: { permissionProfile: "read_only" },
        staticCapabilities: {},
        nativeSessionRoots: [],
        experimental: false,
      },
    ],
    [
      "agent",
      {
        id: "agent",
        name: "Builder",
        avatar: "B",
        definitionId: "fake",
        kind: "profile",
        permissionProfile: "read_only",
        instructions: "",
        hidden: false,
        archived: false,
      },
    ],
  ] as const)
    f.store.dispatch(`seed-${kind}`, (state) =>
      handle(
        state,
        { type: "create", kind, value },
        { commandId: `seed-${kind}`, actor: { kind: "human", id: "local-owner" }, at },
      ),
    );
  f.store.dispatch("seed", () => ({
    events: [
      parseEvent({
        eventId: "thread",
        type: "thread.created",
        aggregateType: "thread",
        aggregateId: "chat",
        occurredAt: at,
        payload: {
          id: "chat",
          agentId: "agent",
          kind: "main",
          title: "Example",
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      }),
      parseEvent({
        eventId: "request",
        type: "interaction.created",
        aggregateType: "interaction",
        aggregateId: "request",
        occurredAt: at,
        payload: {
          id: "request",
          agentId: "agent",
          threadId: "chat",
          type,
          title: "Real title",
          context: { command: "example --check" },
          items: [
            {
              id: "q",
              prompt: "Question",
              ...(type === "approval"
                ? {
                    choices: [
                      { id: "allow_once" },
                      { id: "allow_session", label: "Allow for this session" },
                      { id: "reject_once" },
                    ],
                  }
                : type === "form"
                  ? {
                      schema: {
                        type: "object",
                        properties: { count: { type: "number" } },
                        required: ["count"],
                        additionalProperties: false,
                      },
                    }
                  : { options: [{ id: "yes", label: "Yes" }] }),
            },
          ],
          chain: [],
          urgency: "blocking",
          state: "pending",
          version: 1,
          createdAt: at,
        },
      }),
    ],
    result: {},
  }));
  const respond = vi.fn(async () => {});
  const engine = new InteractionEngine({
    store: f.store,
    publish: () => {},
    host: { respond, registerSecret() {}, requiresSecretReply: () => false },
  });
  const actions: ViewActions = {
    runtime: vi.fn(async () => ({ ok: true })),
    interaction: interactionApi({
      engine,
      snapshot: () => f.store.snapshot(),
      seq: () => f.store.lastSeq(),
    }),
  };
  return {
    ...f,
    actions,
    respond,
    grant: (permissions: string[]) =>
      f.registry.api(
        "view.setGrants",
        { id: "example", permissions, confirmed: true },
        `grant-${permissions.join("-")}`,
      ),
    call: (method: string, params: unknown, confirmed = false) =>
      callView(
        f.registry,
        actions,
        { id: "example", method, params, ...(confirmed ? { confirmed: true } : {}) },
        `call-${method}-${JSON.stringify(params)}-${confirmed}`,
      ),
  };
}
it.each([
  ["chats.send", { chatIds: ["chat"], text: "Hello" }],
  ["chats.interrupt", { chatIds: ["chat"] }],
  ["requests.answer", { requestId: "request", version: 1, choiceId: "allow_once" }],
])("denies %s without its grant at the daemon boundary", async (method, params) => {
  const f = await setup();
  try {
    await f.grant(["read"]);
    await expect(f.call(String(method), params)).rejects.toThrow("not_granted");
    expect(f.respond).not.toHaveBeenCalled();
    expect(f.actions.runtime).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("requires host confirmation for a widening answer and records the view on resolution and audit", async () => {
  const f = await setup();
  try {
    await f.grant(["read", "approve"]);
    const params = { requestId: "request", version: 1, choiceId: "allow_session" };
    await expect(f.call("requests.answer", params)).rejects.toThrow("confirmation_required");
    expect(f.respond).not.toHaveBeenCalled();
    await expect(f.call("requests.answer", { ...params, version: 2 }, true)).rejects.toThrow(
      "stale",
    );
    await f.call("requests.answer", params, true);
    expect(f.store.record("interaction", "request")?.resolution).toMatchObject({
      via: { kind: "view", id: "example" },
      choice: "allow_session",
    });
    expect(f.store.snapshot().audit).toContainEqual(
      expect.objectContaining({
        action: "interaction.answer",
        detail: { confirmed: true, via: { kind: "view", id: "example" } },
      }),
    );
    expect(f.respond).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
it.each([
  "question",
  "form",
  "plan",
  "gate",
] as const)("answers %s through the existing validator and audits the view", async (type) => {
  const f = await setup(type);
  try {
    await f.grant(["read", "approve"]);
    await f.call("requests.answer", {
      requestId: "request",
      version: 1,
      ...(type === "question"
        ? { answers: { q: "yes" } }
        : type === "form"
          ? { answers: { q: { value: { count: 2 } } } }
          : { choiceId: "accept" }),
    });
    expect(f.respond).toHaveBeenCalledOnce();
    expect(f.store.snapshot().audit).toContainEqual(
      expect.objectContaining({
        action: "interaction.answer",
        detail: expect.objectContaining({ via: { kind: "view", id: "example" } }),
      }),
    );
  } finally {
    await f.close();
  }
});
it("queues messages with a view audit and skips interruption when no turn runs", async () => {
  const f = await setup();
  try {
    await f.grant(["read", "act"]);
    expect(await f.call("chats.send", { chatIds: ["chat", "missing"], text: "Hello" })).toEqual([
      { chatId: "chat", result: "queued" },
      { chatId: "missing", result: "skipped", reason: "Chat not found." },
    ]);
    expect(f.actions.runtime).toHaveBeenCalledWith(
      "turn.send",
      { threadId: "chat", input: [{ type: "text", text: "Hello" }], mode: "queue" },
      expect.any(String),
      expect.any(Function),
    );
    expect(f.store.snapshot().audit).toContainEqual(
      expect.objectContaining({
        action: "chats.send",
        detail: {
          via: { kind: "view", id: "example" },
          chatIds: ["chat", "missing"],
          textLength: 5,
        },
      }),
    );
    expect(await f.call("chats.interrupt", { chatIds: ["chat"] })).toEqual([
      { chatId: "chat", result: "skipped", reason: "No running turn." },
    ]);
  } finally {
    await f.close();
  }
});
it("rechecks grants after preparing an answer and before it can commit", async () => {
  const f = await setup();
  try {
    await f.grant(["read", "approve"]);
    f.actions.interaction = async (_method, params, commandId, check) => {
      await f.grant(["read"]);
      f.store.dispatch(commandId, (state) => {
        check?.(state);
        return handle(
          state,
          {
            type: "answer",
            id: String(params.id),
            version: Number(params.version),
            answer: params.answer as InteractionAnswer,
          },
          { commandId, actor: { kind: "human", id: "local-owner" }, at },
        );
      });
    };
    await expect(
      f.call("requests.answer", { requestId: "request", version: 1, choiceId: "allow_once" }),
    ).rejects.toThrow("not_granted");
    expect(f.store.record("interaction", "request")?.state).toBe("pending");
  } finally {
    await f.close();
  }
});

it("rejects forged view attribution on the ordinary interaction API", async () => {
  const f = await setup();
  try {
    await expect(
      f.actions.interaction(
        "interaction.answer",
        {
          id: "request",
          version: 1,
          answer: {
            action: "accept",
            choice: "allow_once",
            by: { kind: "human", id: "local-owner" },
            at,
            via: { kind: "view", id: "example" },
          },
        },
        "forged",
      ),
    ).rejects.toThrow("view_context_required");
    expect(f.respond).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("rechecks grants inside the real interaction engine after asynchronous privacy checks", async () => {
  const f = await setup();
  try {
    await f.grant(["read", "approve"]);
    const engine = new InteractionEngine({
      store: f.store,
      publish: () => {},
      host: { respond: f.respond, registerSecret() {}, requiresSecretReply: () => false },
      preparePublicAnswer: async () => {
        await f.grant(["read"]);
        return () => {};
      },
    });
    f.actions.interaction = interactionApi({
      engine,
      snapshot: () => f.store.snapshot(),
      seq: () => f.store.lastSeq(),
    });
    await expect(
      f.call("requests.answer", { requestId: "request", version: 1, choiceId: "allow_once" }),
    ).rejects.toThrow("not_granted");
    expect(f.store.record("interaction", "request")?.state).toBe("pending");
    expect(f.respond).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
