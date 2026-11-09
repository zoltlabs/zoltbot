import { type Command, handle } from "@zoltbot/core";
import { upsertKnowledge } from "@zoltbot/knowledge";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeTools } from "./runtime-tools.js";

it("derives knowledge authority from the active session, rejects widened args, and records bounded reads", async () => {
  const f = await runtimeFixture();
  let n = 0;
  const change = (command: Command) => {
    const commandId = `k:${++n}`;
    f.store.dispatch(commandId, (s) =>
      handle(s, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  try {
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
    change({
      type: "update",
      kind: "thread",
      id: "thread",
      changes: { projectId: "a", node: { type: "project", id: "a" } },
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
    for (const project of ["a", "b"])
      for (let i = 0; i < 12; i++) {
        const id = `${project}-${i}`,
          commandId = `save:${id}`;
        f.store.dispatch(commandId, (s) =>
          upsertKnowledge(
            s,
            {
              id,
              scope: { type: "project", id: project },
              kind: "decision",
              title: "Meal",
              body: "Meal ".repeat(220),
              status: "active",
              tags: [],
              sources: [],
              revision: 1,
              createdAt: at,
              updatedAt: at,
              owner: { kind: "human", id: "local-owner" },
            },
            0,
            { commandId, at, actor: { kind: "human", id: "local-owner" } },
          ),
        );
      }
    const context = {
      store: f.store,
      privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
      publish() {},
      async wake() {},
    };
    const tools = runtimeTools(context),
      actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
    expect(tools.authorize(actor, "team_get_knowledge", {})).toBe(true);
    expect(tools.authorize({ ...actor, threadId: "foreign" }, "team_get_knowledge", {})).toBe(
      false,
    );
    const read = tools.tools.get("team_get_knowledge");
    if (!read) throw new Error("missing_knowledge_tool");
    await expect(
      read({ actor, arguments: { query: "Meal", projectId: "b" }, idempotencyKey: "widen" }),
    ).rejects.toThrow("invalid_knowledge_query");
    const result = (await read({
      actor,
      arguments: { query: "Meal" },
      idempotencyKey: "read",
    })) as { items: { id: string; text: string }[] };
    expect(result.items.length).toBeLessThanOrEqual(10);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((row) => row.id.startsWith("a-") && row.text.length <= 400)).toBe(
      true,
    );
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4000);
    expect(
      f.store.database
        .prepare("SELECT count(*) AS n FROM knowledge_reads_aux WHERE token_estimate>0")
        .get(),
    ).toEqual({ n: 1 });
    context.privacy.remember("synthetic-query-private-value");
    await expect(
      read({
        actor,
        arguments: { query: "synthetic-query-private-value" },
        idempotencyKey: "private-query",
      }),
    ).rejects.toThrow();
    expect(
      JSON.stringify(f.store.database.prepare("SELECT query FROM knowledge_reads_aux").all()),
    ).not.toContain("synthetic-query-private-value");
    expect(f.store.database.prepare("SELECT query FROM knowledge_reads_aux").get()).toEqual({
      query: null,
    });
  } finally {
    f.close();
  }
});
