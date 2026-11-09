import { createTask, finishTaskTurn, handle, queueHumanInput, startTask } from "@zoltbot/core";
import { estimateKnowledgeTokens, frozenKnowledgePack, upsertKnowledge } from "@zoltbot/knowledge";
import { expect, it } from "vitest";
import { ReferenceSession } from "../../../tools/fakes/src/reference-adapter.js";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import {
  composeLaunchManifest,
  type LaunchManifest,
} from "../../connections/src/launch-manifest.js";
import { knowledgeLaunch } from "./knowledge-launch.js";
import { type RuntimeHost, SessionManager } from "./session-manager.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("knowledge_launch_timeout");
}
it("injects exact frozen pack bytes once, keeps request-changes native identity and restores after restart without reinjection", async () => {
  const f = await runtimeFixture();
  let n = 0;
  const prompts: unknown[] = [];
  let manager: SessionManager | undefined;
  const context = () => ({
    commandId: `knowledge-run:${++n}`,
    at,
    actor: { kind: "human" as const, id: "local-owner" },
  });
  const run = (produce: Parameters<typeof f.store.dispatch>[1]) =>
    f.store.dispatch(`knowledge-run:${++n}`, produce);
  const knowledge = {
    id: "decision",
    scope: { type: "project" as const, id: "p" },
    kind: "decision",
    title: "Meal units",
    body: "Always show grams.",
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
  };
  try {
    run((s) =>
      handle(
        s,
        {
          type: "create",
          kind: "project",
          value: {
            id: "p",
            name: "P",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 0,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        context(),
      ),
    );
    run((s) => upsertKnowledge(s, knowledge, 0, context()));
    run((s) =>
      createTask(
        s,
        {
          id: "task",
          title: "Meals",
          brief: "Show meal units",
          node: { type: "project", id: "p" },
          profileId: "profile",
        },
        context(),
      ),
    );
    const host: RuntimeHost = {
      async prepare(input) {
        const saved = input.previous?.configuration as
          | { launchManifest: LaunchManifest }
          | undefined;
        const candidate = saved?.launchManifest.knowledge ?? knowledgeLaunch(f.store, input, 1200);
        const manifest =
          saved?.launchManifest ??
          composeLaunchManifest(
            {
              executionId: "execution",
              threadId: input.thread.id,
              taskId: "task",
              taskRevision: 1,
              projectId: "p",
              profileId: input.profile.id,
              configurationHash: "fixture",
              cwd: f.root,
            },
            { ...(candidate ? { knowledge: candidate } : {}) },
            { limit: 1500, fixed: 0 },
          );
        return {
          cwd: f.root,
          estimate: estimateKnowledgeTokens,
          configuration: { launchManifest: manifest },
          ...(manifest.knowledge ? { firstTurnKnowledge: manifest.knowledge } : {}),
          async open(request) {
            const session = await new ReferenceSession({
              identity: { agentId: input.profile.id, threadId: input.thread.id },
              mode: request.mode,
              ...(request.nativeId ? { nativeId: request.nativeId } : {}),
              cwd: f.root,
              permissionProfile: "read_only",
              hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
            }).open();
            const send = session.send.bind(session);
            session.send = (value, mode) => {
              prompts.push(structuredClone(value));
              return send(value, mode);
            };
            return session;
          },
        };
      },
    };
    manager = new SessionManager({ store: f.store, host, publish() {} });
    run((s) => startTask(s, "task", 1, context()));
    await (await manager.ensure("task:thread")).wake();
    await until(
      () =>
        f.store
          .snapshot(["turn"])
          .turn?.some((row) => row.threadId === "task:thread" && row.status === "completed") ===
        true,
    );
    const frozen = frozenKnowledgePack(f.store, "task");
    expect(frozen?.included[0]?.revision).toBe(1);
    const packText = (prompts[0] as { type: string; text?: string }[]).at(-1)?.text;
    expect(packText).toContain("Always show grams.");
    expect(packText).toContain("decision@1");
    run((s) => upsertKnowledge(s, { ...knowledge, body: "Always show ounces." }, 1, context()));
    run((s) => finishTaskTurn(s, "task", 1, { status: "completed", text: "done" }, context()));
    run((s) =>
      handle(
        s,
        { type: "review", id: "task", revision: 1, decision: "changes", feedback: "Round units" },
        context(),
      ),
    );
    run((s) => startTask(s, "task", 2, context()));
    await (await manager.ensure("task:thread")).wake();
    await until(
      () =>
        prompts.length === 2 &&
        f.store
          .snapshot(["turn"])
          .turn?.filter((row) => row.threadId === "task:thread" && row.status === "completed")
          .length === 2,
    );
    expect(JSON.stringify(prompts[1])).not.toContain("Project knowledge");
    expect(frozenKnowledgePack(f.store, "task")).toEqual(frozen);
    const sessions = f.store
      .snapshot(["session"])
      .session?.filter((row) => row.threadId === "task:thread");
    const nativeId = sessions?.[0]?.nativeId;
    await manager.close();
    manager = new SessionManager({ store: f.store, host, publish() {} });
    run((s) =>
      queueHumanInput(
        s,
        {
          threadId: "task:thread",
          input: [{ type: "text", text: "Continue from your own native context" }],
          mode: "queue",
        },
        "continue",
        context(),
      ),
    );
    await (await manager.ensure("task:thread")).wake();
    await until(() => prompts.length === 3);
    expect(JSON.stringify(prompts[2])).not.toContain("Project knowledge");
    expect(
      f.store
        .snapshot(["session"])
        .session?.filter((row) => row.threadId === "task:thread")
        .every((row) => row.nativeId === nativeId),
    ).toBe(true);
    expect(frozenKnowledgePack(f.store, "task")).toEqual(frozen);
    const { knowledgeUpdate } = await import("./knowledge-update.js");
    knowledgeUpdate(
      {
        store: f.store,
        publish() {},
        wake: async (threadId) => {
          await (await manager?.ensure(threadId))?.wake();
        },
      },
      { taskId: "task", ids: ["decision"], confirmed: true },
      "explicit-update",
    );
    await until(() => prompts.length === 4);
    expect(JSON.stringify(prompts[3])).toContain("Human-requested knowledge update");
    expect(JSON.stringify(prompts[3])).toContain("Always show ounces.");
    expect(frozenKnowledgePack(f.store, "task")).toEqual(frozen);
    expect(
      f.store.database
        .prepare(
          "SELECT token_estimate AS n FROM knowledge_reads_aux WHERE id='update:explicit-update'",
        )
        .get(),
    ).toMatchObject({ n: expect.any(Number) });
  } finally {
    await manager?.close();
    f.close();
  }
});

it("rolls back session, manifest, frozen pack and receipt together at every durable intent kill point", async () => {
  const f = await runtimeFixture();
  try {
    const context = {
      commandId: "seed-knowledge-crash",
      at,
      actor: { kind: "human" as const, id: "local-owner" },
    };
    f.store.dispatch("seed-project", (s) =>
      handle(
        s,
        {
          type: "create",
          kind: "project",
          value: {
            id: "p",
            name: "P",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 0,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        { ...context, commandId: "seed-project" },
      ),
    );
    f.store.dispatch("seed-task", (s) =>
      createTask(
        s,
        {
          id: "crash-task",
          title: "Crash",
          brief: "Check intent",
          profileId: "profile",
          node: { type: "project", id: "p" },
        },
        { ...context, commandId: "seed-task" },
      ),
    );
    const pack = {
      id: "crash-pack",
      taskId: "crash-task",
      revision: 1,
      included: [],
      excluded: [],
      tokenEstimate: 0,
      createdAt: at,
    };
    const configuration = {
      launchManifest: composeLaunchManifest(
        {
          executionId: "crash-execution",
          threadId: "crash-task:thread",
          taskId: "crash-task",
          profileId: "profile",
          cwd: f.root,
          configurationHash: "test",
        },
        { knowledge: { packId: pack.id, pack, text: "", tokens: 0 } },
        { limit: 1500, fixed: 0 },
      ),
    };
    const { launchIntent } = await import("./connections-intent.js");
    const produce = (s: Parameters<typeof handle>[0]) =>
      launchIntent(
        s,
        context,
        handle(
          s,
          {
            type: "create",
            kind: "session",
            value: {
              id: "crash-session",
              threadId: "crash-task:thread",
              provider: "reference",
              cwd: f.root,
              state: "starting",
              capabilities: {},
              startedAt: at,
            },
          },
          context,
        ),
        "crash-session",
        configuration,
      );
    const before = f.store.snapshot(),
      seq = f.store.lastSeq();
    for (const killPoint of [
      "before_events",
      "after_events",
      "after_projections",
      "after_receipt",
    ] as const) {
      expect(() => f.store.dispatch(`crash:${killPoint}`, produce, { killPoint })).toThrow(
        "kill point",
      );
      expect(f.store.snapshot()).toEqual(before);
      expect(f.store.lastSeq()).toBe(seq);
      expect(f.store.receipt(`crash:${killPoint}`)).toBeUndefined();
    }
    f.store.dispatch("successful-intent", produce);
    expect(f.store.record("session", "crash-session")).toBeDefined();
    expect(f.store.record("settings", "runtime.configuration.crash-session")).toMatchObject({
      value: configuration,
    });
    expect(frozenKnowledgePack(f.store, "crash-task")).toEqual(pack);
  } finally {
    f.close();
  }
});
