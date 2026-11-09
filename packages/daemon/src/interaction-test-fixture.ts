import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import type { DomainEvent, InteractionAnswer } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { InteractionEngine, type InteractionHost } from "./interaction-engine.js";
import { Redactor } from "./logging.js";

export const at = "2026-10-27T12:00:00.000Z";
export const human = { kind: "human" as const, id: "owner" };
export const draft = {
  id: "question",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  items: [{ id: "q", prompt: "Answer", secret: true }],
  chain: [],
  urgency: "blocking",
};
export async function fixture() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/interaction-engine-"));
  const store = await openStore(path.join(root, "store.db"));
  const definition = {
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
  };
  const profile = {
    id: "profile",
    name: "Builder",
    avatar: "B",
    definitionId: "fake",
    kind: "profile",
    permissionProfile: "read_only",
    instructions: "",
    hidden: false,
    archived: false,
  };
  const thread = {
    id: "thread",
    agentId: "profile",
    kind: "main",
    title: "Test",
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: at,
    lastActivityAt: at,
  };
  for (const [kind, value] of [
    ["agentDefinition", definition],
    ["agent", profile],
    ["thread", thread],
  ] as const)
    store.dispatch(`seed:${kind}`, (state) =>
      handle(
        state,
        { type: "create", kind, value },
        { commandId: `seed:${kind}`, at, actor: human },
      ),
    );
  const events: DomainEvent[] = [],
    replies: InteractionAnswer[] = [],
    frames = new Redactor(),
    queuedThreads: string[] = [];
  const host: InteractionHost = {
    registerSecret: (value) => {
      frames.register(value);
      frames.hideFrames();
    },
    requiresSecretReply: () => true,
    respond: async (_interaction, answer) => {
      replies.push(answer);
    },
  };
  const engine = new InteractionEngine({
    store,
    host,
    publish: (batch) => events.push(...batch),
    now: () => at,
    onQueued: (threadId) => queuedThreads.push(threadId),
  });
  engine.request(draft, "request");
  return {
    root,
    store,
    host,
    engine,
    events,
    replies,
    frames,
    queuedThreads,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
