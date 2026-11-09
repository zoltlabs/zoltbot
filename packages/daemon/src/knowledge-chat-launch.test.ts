import { handle, queueHumanInput } from "@zoltbot/core";
import { estimateKnowledgeTokens, upsertKnowledge } from "@zoltbot/knowledge";
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
  throw new Error("knowledge_chat_timeout");
}
const owner = { kind: "human" as const, id: "local-owner" };
const project = (id: string) => ({
  id,
  name: id,
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
});
const knowledge = (id: string, scope: { type: "user" | "project"; id: string }, body: string) => ({
  id,
  scope,
  kind: "preference",
  title: id,
  body,
  status: "active",
  tags: [],
  sources: [],
  revision: 1,
  owner,
  verification: "human",
  writer: owner,
  createdAt: at,
  updatedAt: at,
  pinned: true,
});

async function chatFixture(projectId: string) {
  const f = await runtimeFixture();
  let n = 0;
  const context = () => ({ commandId: `chat:${++n}`, at, actor: owner });
  const run = (produce: Parameters<typeof f.store.dispatch>[1]) =>
    f.store.dispatch(`chat:${++n}`, produce);
  for (const id of ["a", "b"])
    run((s) => handle(s, { type: "create", kind: "project", value: project(id) }, context()));
  run((s) =>
    handle(
      s,
      { type: "create", kind: "settings", value: { key: "knowledge.inheritUser.b", value: false } },
      context(),
    ),
  );
  run((s) =>
    upsertKnowledge(
      s,
      knowledge("tabs", { type: "user", id: "local" }, "Indent with tabs."),
      0,
      context(),
    ),
  );
  run((s) =>
    upsertKnowledge(
      s,
      knowledge("units", { type: "project", id: projectId }, "Use grams."),
      0,
      context(),
    ),
  );
  run((s) =>
    handle(
      s,
      {
        type: "create",
        kind: "thread",
        value: {
          id: "chat",
          agentId: "profile",
          projectId,
          kind: "main",
          title: "Planning",
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      },
      context(),
    ),
  );
  const prompts: unknown[] = [],
    opens: unknown[] = [];
  let packs = 0;
  const host: RuntimeHost = {
    async prepare(input) {
      const saved = input.previous?.configuration as { launchManifest: LaunchManifest } | undefined;
      const candidate = saved?.launchManifest.knowledge ?? knowledgeLaunch(f.store, input, 1200);
      if (!saved && candidate) packs++;
      const manifest =
        saved?.launchManifest ??
        composeLaunchManifest(
          {
            executionId: `execution-${packs}`,
            threadId: input.thread.id,
            projectId,
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
          opens.push(structuredClone(request));
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
  const say = (text: string) =>
    run((s) =>
      queueHumanInput(
        s,
        { threadId: "chat", input: [{ type: "text", text }], mode: "queue" },
        `say:${++n}`,
        context(),
      ),
    );
  const completed = () =>
    f.store
      .snapshot(["turn"])
      .turn?.filter((r) => r.threadId === "chat" && r.status === "completed").length ?? 0;
  return { f, host, prompts, opens, say, completed, packs: () => packs };
}

it("appends a chat pack once after the first human message and never re-injects on resume", async () => {
  const c = await chatFixture("a");
  let manager = new SessionManager({ store: c.f.store, host: c.host, publish() {} });
  try {
    c.say("Plan the week");
    await (await manager.ensure("chat")).wake();
    await until(() => c.completed() === 1);
    const first = c.prompts[0] as { type: string; text?: string }[];
    expect(first[0]).toEqual({ type: "text", text: "Plan the week" });
    const pack = first.at(-1)?.text ?? "";
    expect(pack).toContain("[preference tabs@1 · user:local] tabs\nIndent with tabs.");
    expect(pack).toContain("[preference units@1 · project:a] units\nUse grams.");
    expect(first.filter((part) => part.text?.includes("Project knowledge"))).toHaveLength(1);
    // The pack never reaches the open request: system prompt and tool list are unchanged.
    expect(JSON.stringify(c.opens)).not.toContain("Indent with tabs.");
    const frozen = c.f.store
      .snapshot(["contextPack"])
      .contextPack?.filter((row) => row.threadId === "chat");
    expect(frozen?.map((row) => row.taskId)).toEqual([undefined]);
    c.say("And next week?");
    await (await manager.ensure("chat")).wake();
    await until(() => c.completed() === 2);
    expect(JSON.stringify(c.prompts[1])).not.toContain("Project knowledge");
    await manager.close();
    manager = new SessionManager({ store: c.f.store, host: c.host, publish() {} });
    c.say("Resume after restart");
    await (await manager.ensure("chat")).wake();
    await until(() => c.prompts.length === 3);
    expect(JSON.stringify(c.prompts[2])).not.toContain("Project knowledge");
    expect(c.packs()).toBe(1);
  } finally {
    await manager.close();
    c.f.close();
  }
});

it("leaves user knowledge out of chats in a project that opted out", async () => {
  const c = await chatFixture("b");
  const manager = new SessionManager({ store: c.f.store, host: c.host, publish() {} });
  try {
    c.say("Plan the week");
    await (await manager.ensure("chat")).wake();
    await until(() => c.completed() === 1);
    const text = JSON.stringify(c.prompts[0]);
    expect(text).toContain("Use grams.");
    expect(text).not.toContain("Indent with tabs.");
  } finally {
    await manager.close();
    c.f.close();
  }
});
