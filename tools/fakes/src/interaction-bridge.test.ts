import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { ConformanceFactory } from "@zoltbot/adapters-sdk/conformance";
import { observeRuntimeEvent } from "@zoltbot/core";
import { Redactor, redactRuntimeEvent, startDaemon } from "@zoltbot/daemon";
import type { AgentEvent, InteractionAnswer } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { acpFactory } from "./acp-conformance-factory.js";
import { claudeFactory } from "./claude-conformance-factory.js";
import { codexFactory } from "./codex-conformance-factory.js";
import { piFactory } from "./pi-conformance-factory.js";

async function rpc(url: string, token: string, params: unknown, commandId = "socket:2") {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket_failed")), { once: true });
  });
  const call = (id: number, method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      socket.addEventListener(
        "message",
        (event) => {
          const value = JSON.parse(String(event.data));
          if (value.error) reject(new Error(value.error.message));
          else resolve(value.result);
        },
        { once: true },
      );
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
          commandId: id === 2 ? commandId : `socket:${id}`,
        }),
      );
    });
  try {
    await call(1, "hello", { protocolVersion: 1, token });
    return await call(2, "interaction.answer", params);
  } finally {
    socket.close();
  }
}
const providers: [string, ConformanceFactory][] = [
  ["claude", claudeFactory],
  ["codex", codexFactory],
  ["acp", acpFactory("cursor")],
  ["pi", piFactory],
];
for (const [provider, factory] of providers)
  it(`persists and answers ${provider} native interactions through the socket and protocol`, async () => {
    const question = provider !== "pi";
    const scenario = question ? "duplicate_questions" : "approve";
    const fixture = await factory(scenario);
    mkdirSync(".cache/tests", { recursive: true });
    const root = mkdtempSync(path.resolve(".cache/tests/interaction-bridge-"));
    const daemon = await startDaemon({
      dataDir: root,
      interactionHost: {
        registerSecret() {
          throw new Error("unexpected_private_question");
        },
        requiresSecretReply: () => true,
        respond: async (request, answer) => fixture.session.respond(request.id, answer),
      },
    }).catch(async (error) => {
      await fixture.dispose();
      rmSync(root, { recursive: true, force: true });
      throw error;
    });
    try {
      if (!fixture.cwd || !daemon.interactions) throw new Error("missing_fixture_runtime");
      const at = new Date().toISOString();
      const definition = {
        id: "test-definition",
        displayName: "Fixture",
        adapter: provider,
        binaryNames: [],
        versionCommand: [],
        launch: { command: "fake", args: [], env: {} },
        testedVersions: "1.0.0",
        defaults: { permissionProfile: "workspace_write" },
        staticCapabilities: {},
        nativeSessionRoots: [],
        experimental: false,
      };
      const profile = {
        id: "test-profile",
        name: "Fixture",
        avatar: "F",
        definitionId: definition.id,
        kind: "profile",
        permissionProfile: "workspace_write",
        instructions: "",
        hidden: false,
        archived: false,
      };
      const thread = {
        id: "test-thread",
        agentId: profile.id,
        kind: "main",
        title: "Fixture",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      };
      const session = {
        id: "runtime",
        threadId: thread.id,
        provider,
        nativeId: fixture.session.nativeId,
        cwd: fixture.cwd,
        state: "starting",
        capabilities: fixture.session.capabilities,
        startedAt: at,
      };
      for (const [kind, value] of [
        ["agentDefinition", definition],
        ["agent", profile],
        ["thread", thread],
        ["session", session],
      ] as const)
        daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
      await fixture.session.send(
        [{ type: "text", text: question ? scenario : "approval" }],
        "queue",
      );
      await expect
        .poll(() => fixture.trace.some((event) => event.t === "interaction.requested"))
        .toBe(true);
      const event = fixture.trace.find((event) => event.t === "interaction.requested");
      if (!event || event.t !== "interaction.requested" || !event.interaction.turnId)
        throw new Error("missing_question");
      const nativeTurnId = event.interaction.turnId;
      const ids = new Map<string, string>();
      const contentRedactor = new Redactor(["seeded-secret", "1"]);
      const applyNative = (nativeEvent: AgentEvent, index: number) => {
        const key = "itemId" in nativeEvent ? nativeEvent.itemId : nativeEvent.t;
        if (!ids.has(key)) ids.set(key, randomUUID());
        const itemId = ids.get(key);
        if (!itemId) throw new Error("missing_runtime_item_id");
        const commandId = `native:${index}`;
        daemon.store.dispatch(commandId, (state) =>
          observeRuntimeEvent(
            state,
            {
              sessionId: session.id,
              threadId: thread.id,
              turnId: nativeTurnId,
              itemId,
              event: redactRuntimeEvent(nativeEvent, contentRedactor),
            },
            { commandId, at, actor: { kind: "system", id: "runtime" } },
          ),
        );
      };
      for (const [index, nativeEvent] of fixture.trace.entries())
        if (nativeEvent.t === "session.ready" || nativeEvent.t === "turn.started")
          applyNative(nativeEvent, index);
      const sanitizedRequest = redactRuntimeEvent(event, contentRedactor);
      if (sanitizedRequest.t !== "interaction.requested")
        throw new Error("missing_sanitized_request");
      const request = daemon.interactions.request(sanitizedRequest.interaction, "request");
      expect(request.items).toHaveLength(question ? 2 : 1);
      if (question) expect(request.items[0]?.prompt).toBe(request.items[1]?.prompt);
      const features = fixture.session.capabilities.questionFeatures ?? {
        multi: true,
        other: true,
      };
      const first = request.items[0],
        second = request.items[1];
      // The fixtures use a 700 ms stall deadline; waiting for a human must suspend it.
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(fixture.trace.some((event) => event.t === "turn.done")).toBe(false);
      expect(daemon.store.snapshot().interaction?.[0]?.state).toBe("pending");
      let answers: InteractionAnswer["answers"];
      if (question) {
        if (!first || !second) throw new Error("missing_items");
        answers = {
          [first.id]: {
            options: (first.options ?? [])
              .slice(0, features.multi ? 2 : 1)
              .map((option) => option.id),
          },
          [second.id]: features.other
            ? { other: "free text" }
            : { options: (second.options ?? []).slice(0, 1).map((option) => option.id) },
        };
      }
      expect(
        await rpc(daemon.url, daemon.token, {
          id: request.id,
          version: 1,
          answer: {
            action: "accept",
            answers,
            choice: question ? undefined : "allow_once",
            by: { kind: "human", id: "owner" },
            at,
          },
        }),
      ).toMatchObject({ state: "answered", version: 2 });
      await expect
        .poll(() =>
          fixture.trace.some((event) => event.t === "turn.done" && event.status === "completed"),
        )
        .toBe(true);
      if (question)
        expect(daemon.store.snapshot().interaction?.[0]).toMatchObject({ resolution: { answers } });
      else {
        expect(daemon.store.snapshot().interaction?.[0]).toMatchObject({
          resolution: { choice: "allow_once" },
        });
        expect(daemon.store.snapshot().audit).toHaveLength(1);
      }
      const output = fixture.trace
        .filter((event) => event.t === "tool.done")
        .map((event) => JSON.stringify(event))
        .join("\n");
      expect(output).toContain(
        question ? (features.other ? "free text" : second?.options?.[0]?.id) : "allowed",
      );
      if (provider === "claude") {
        expect(output).toContain(`[1] ${first?.options?.[0]?.label}`);
        for (const option of (first?.options ?? []).slice(1, features.multi ? 2 : 1))
          expect(output).toContain(`, ${option.label}`);
        expect(output).toContain("[2] free text");
      }
      for (const [index, nativeEvent] of fixture.trace.entries())
        if (
          [
            "message.done",
            "thought.done",
            "tool.started",
            "tool.updated",
            "tool.done",
            "plan.updated",
            "turn.done",
          ].includes(nativeEvent.t)
        )
          applyNative(nativeEvent, index);
      expect(daemon.store.snapshot().turn?.some((turn) => turn.status === "completed")).toBe(true);
      expect(daemon.store.snapshot().session?.[0]?.state).toBe("ready");
      expect(daemon.store.snapshot().item?.some((item) => item.kind === "tool")).toBe(true);
      expect(daemon.store.snapshot().item?.some((item) => item.kind === "interaction")).toBe(true);
    } finally {
      await daemon.close();
      await fixture.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

it("bridges sequential Pi questions with duplicate prompts and independent answers", async () => {
  const fixture = await piFactory("duplicate_questions");
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/pi-question-bridge-"));
  const daemon = await startDaemon({
    dataDir: root,
    interactionHost: {
      registerSecret() {
        throw new Error("unexpected_private_question");
      },
      requiresSecretReply: () => false,
      respond: async (request, answer) => fixture.session.respond(request.id, answer),
    },
  });
  try {
    const at = new Date().toISOString();
    daemon.dispatch(
      {
        type: "create",
        kind: "agentDefinition",
        value: {
          id: "pi-question-definition",
          displayName: "Pi fixture",
          adapter: "pi",
          binaryNames: [],
          versionCommand: [],
          launch: { command: "fake", args: [], env: {} },
          testedVersions: "1.4.0",
          defaults: { permissionProfile: "workspace_write" },
          staticCapabilities: {},
          nativeSessionRoots: [],
          experimental: false,
        },
      },
      "seed:definition",
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "agent",
        value: {
          id: "test-profile",
          name: "Pi fixture",
          avatar: "P",
          definitionId: "pi-question-definition",
          kind: "profile",
          permissionProfile: "workspace_write",
          instructions: "",
          hidden: false,
          archived: false,
        },
      },
      "seed:profile",
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "thread",
        value: {
          id: "test-thread",
          agentId: "test-profile",
          kind: "main",
          title: "Pi questions",
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      },
      "seed:thread",
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "session",
        value: {
          id: "pi-question-session",
          threadId: "test-thread",
          provider: "pi",
          nativeId: fixture.session.nativeId,
          cwd: fixture.cwd,
          state: "starting",
          capabilities: fixture.session.capabilities,
          startedAt: at,
        },
      },
      "seed:session",
    );
    if (!daemon.interactions) throw new Error("missing_interaction_engine");
    expect(fixture.session.capabilities.questions).toBe("native");
    await fixture.session.send([{ type: "text", text: "duplicate_questions" }], "queue");
    const questions = () => fixture.trace.filter((event) => event.t === "interaction.requested");
    await expect.poll(() => questions().length).toBe(1);
    const first = questions()[0];
    if (!first || first.t !== "interaction.requested" || !first.interaction.turnId)
      throw new Error("missing_question");
    const nativeTurnId = first.interaction.turnId;
    for (const [index, event] of fixture.trace.entries()) {
      if (event.t !== "session.ready" && event.t !== "turn.started") continue;
      const commandId = `pi-question-native:${index}`;
      daemon.store.dispatch(commandId, (state) =>
        observeRuntimeEvent(
          state,
          {
            sessionId: "pi-question-session",
            threadId: "test-thread",
            turnId: nativeTurnId,
            itemId: randomUUID(),
            event,
          },
          { commandId, at, actor: { kind: "system", id: "runtime" } },
        ),
      );
    }
    daemon.interactions.request(first.interaction, "first-question");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fixture.trace.some((event) => event.t === "turn.done")).toBe(false);
    const answer: InteractionAnswer = {
      action: "accept",
      by: { kind: "human", id: "owner" },
      at: new Date().toISOString(),
    };
    await expect(
      fixture.session.respond(first.interaction.id, {
        ...answer,
        answers: { question: { options: ["missing"] } },
      }),
    ).rejects.toThrow("invalid_question_answer");
    expect(daemon.store.snapshot().interaction?.[0]?.state).toBe("pending");
    await rpc(
      daemon.url,
      daemon.token,
      {
        id: first.interaction.id,
        version: 1,
        answer: { ...answer, answers: { question: { options: ["1"] } } },
      },
      `answer:${first.interaction.id}`,
    );
    await expect.poll(() => questions().length).toBe(2);
    const second = questions()[1];
    if (!second || second.t !== "interaction.requested") throw new Error("missing_second_question");
    expect(second.interaction.id).not.toBe(first.interaction.id);
    expect(second.interaction.items[0]?.prompt).toBe(first.interaction.items[0]?.prompt);
    daemon.interactions.request(second.interaction, "second-question");
    await rpc(
      daemon.url,
      daemon.token,
      {
        id: second.interaction.id,
        version: 1,
        answer: { ...answer, answers: { question: { other: "free text" } } },
      },
      `answer:${second.interaction.id}`,
    );
    await expect
      .poll(() =>
        fixture.trace.some((event) => event.t === "turn.done" && event.status === "completed"),
      )
      .toBe(true);
    const outputs = fixture.trace.filter((event) => event.t === "tool.done");
    expect(JSON.stringify(outputs)).toContain("Second");
    expect(JSON.stringify(outputs)).toContain("free text");
    expect(fixture.trace.filter((event) => event.t === "interaction.cleared")).toHaveLength(2);
    const saved = daemon.store.snapshot().interaction ?? [];
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => row.state === "answered" && row.version === 2)).toBe(true);
    expect(saved.find((row) => row.id === first.interaction.id)).toMatchObject({
      resolution: { answers: { question: { options: ["1"] } } },
    });
    expect(saved.find((row) => row.id === second.interaction.id)).toMatchObject({
      resolution: { answers: { question: { other: "free text" } } },
    });
  } finally {
    await daemon.close();
    await fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("cancels a Pi select request without inventing a native selection", async () => {
  const fixture = await piFactory("question");
  try {
    await fixture.session.send([{ type: "text", text: "question" }], "queue");
    await expect
      .poll(() => fixture.trace.some((event) => event.t === "interaction.requested"))
      .toBe(true);
    const event = fixture.trace.find((event) => event.t === "interaction.requested");
    if (!event || event.t !== "interaction.requested") throw new Error("missing_question");
    await fixture.session.respond(event.interaction.id, {
      action: "cancel",
      by: { kind: "human", id: "owner" },
      at: new Date().toISOString(),
    });
    await expect
      .poll(() =>
        fixture.trace.some((event) => event.t === "turn.done" && event.status === "completed"),
      )
      .toBe(true);
    expect(JSON.stringify(fixture.trace.filter((event) => event.t === "tool.done"))).toContain(
      "cancelled",
    );
  } finally {
    await fixture.dispose();
  }
});
