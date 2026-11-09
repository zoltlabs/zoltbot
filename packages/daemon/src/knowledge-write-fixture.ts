import { type Command, createTask, handle } from "@zoltbot/core";
import { upsertKnowledge } from "@zoltbot/knowledge";
import type { DomainEvent, KnowledgeItem } from "@zoltbot/protocol";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeTools } from "./runtime-tools.js";

/** Test-only: an active session in project "a" whose thread runs task "t". */
export async function knowledgeWriteFixture(options: { task?: boolean } = {}) {
  const f = await runtimeFixture();
  let n = 0;
  const change = (command: Command, actor = { kind: "system" as const, id: "test" }) => {
    const commandId = `kw:${++n}`;
    f.store.dispatch(commandId, (s) => handle(s, command, { commandId, at, actor }));
  };
  for (const id of ["a", "b"])
    change({
      type: "create",
      kind: "project",
      value: {
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
      },
    });
  if (options.task !== false) {
    const commandId = `kw:${++n}`;
    f.store.dispatch(commandId, (s) =>
      createTask(
        s,
        {
          id: "t",
          title: "Fix CI",
          brief: "Fix CI",
          node: { type: "project", id: "a" },
          profileId: "profile",
        },
        { commandId, at, actor: { kind: "human", id: "local-owner" } },
      ),
    );
  }
  change({
    type: "update",
    kind: "thread",
    id: "thread",
    changes: {
      projectId: "a",
      node: { type: "project", id: "a" },
      ...(options.task !== false ? { taskId: "t" } : {}),
    },
  });
  change({ type: "transition", kind: "session", id: "session", to: "ready" });
  change({ type: "transition", kind: "session", id: "session", to: "running" });
  change({
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      threadId: "thread",
      sessionId: "session",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  const published: DomainEvent[] = [];
  const context = {
    store: f.store,
    privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
    publish: (events: DomainEvent[]) => published.push(...events),
    async wake() {},
  };
  const tools = runtimeTools(context);
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  let calls = 0;
  const write = async (args: Record<string, unknown>, who = actor) => {
    const tool = tools.tools.get("team_write_knowledge");
    if (!tool) throw new Error("missing_write_tool");
    return (await tool({ actor: who, arguments: args, idempotencyKey: `w${++calls}` })) as {
      result: string;
      id?: string;
      revision?: number;
      why: string;
    };
  };
  const save = (item: Partial<KnowledgeItem> & { id: string }) => {
    const commandId = `kw:${++n}`;
    const current = f.store.record("knowledge", item.id) as KnowledgeItem | undefined;
    f.store.dispatch(commandId, (s) =>
      upsertKnowledge(
        s,
        {
          scope: { type: "project", id: "a" },
          kind: "constraint",
          title: item.id,
          body: `${item.id} body`,
          status: "active",
          tags: [],
          sources: [],
          revision: 1,
          createdAt: at,
          updatedAt: at,
          owner: { kind: "human", id: "local-owner" },
          ...current,
          ...item,
        },
        current?.revision ?? 0,
        { commandId, at, actor: { kind: "human", id: "local-owner" } },
      ),
    );
  };
  return { f, change, context, tools, actor, write, save, published };
}
