import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEvents, type DomainState } from "@zoltbot/core";
import type { KnowledgeItem } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach, expect, it } from "vitest";
import { upsertKnowledge } from "./commands.js";
import {
  freezeKnowledgePack,
  frozenKnowledgePack,
  knowledgeHistory,
  knowledgeMatches,
  readKnowledge,
} from "./repository.js";
import { buildKnowledgePack, estimateKnowledgeTokens, matchQuery } from "./retrieval.js";

const at = "2026-11-04T00:00:00Z";
const scope = { type: "project" as const, id: "a" };
const context = { commandId: "save", at, actor: { kind: "human" as const, id: "owner" } };
const project = (id: string) => ({
  id,
  name: id,
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
});
function item(id: string, changes: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id,
    scope,
    title: "Meal accuracy",
    body: "Use grams for meal accuracy.",
    kind: "constraint",
    status: "active",
    tags: [],
    sources: [],
    revision: 1,
    owner: context.actor,
    verification: "human",
    writer: context.actor,
    createdAt: at,
    updatedAt: at,
    ...changes,
  };
}
const fixture = (): DomainState => ({ project: [project("a"), project("b")], knowledge: [] });
const input = {
  id: "pack",
  taskId: "task",
  revision: 1,
  scope,
  query: "meal",
  at,
  remainingTokens: 1200,
};
const stores: Store[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function database() {
  const dir = mkdtempSync(path.join(tmpdir(), "zolt-knowledge-"));
  dirs.push(dir);
  const store = await openStore(path.join(dir, "test.db"));
  stores.push(store);
  return store;
}
it("CAS writes preserve revisions, reject moved scopes, cycles and cross-project provenance", () => {
  const state = fixture();
  const saved = upsertKnowledge(state, item("one"), 0, context);
  const next = applyEvents(state, saved.events);
  expect(() => upsertKnowledge(next, item("one"), 0, context)).toThrow(
    "knowledge_revision_conflict",
  );
  expect(upsertKnowledge(next, item("one", { body: "Edited" }), 1, context).result.revision).toBe(
    2,
  );
  expect(() =>
    upsertKnowledge(next, item("one", { scope: { type: "project", id: "b" } }), 1, context),
  ).toThrow("knowledge_scope_immutable");
  expect(() => upsertKnowledge(next, item("one", { supersedes: "one" }), 1, context)).toThrow(
    "cycle",
  );
  expect(() =>
    upsertKnowledge(next, item("two", { sources: [{ kind: "task", ref: "foreign" }] }), 0, context),
  ).toThrow("source_unavailable");
});
it("resolves narrower keyed overrides and stable ties before ranking", () => {
  const state = fixture();
  state.subproject = [
    {
      id: "child",
      projectId: "a",
      name: "Child",
      label: "Direction",
      goal: "",
      instructions: "",
      depth: 1,
      archived: false,
      createdAt: at,
    },
  ];
  state.knowledge = [
    item("parent", { key: "units", pinned: true }),
    item("child", { scope: { type: "subproject", id: "child" }, key: "units" }),
    item("tie-b"),
    item("tie-a"),
  ];
  const result = buildKnowledgePack(state, {
    ...input,
    scope: { type: "subproject", id: "child" },
  });
  expect(result.pack.included.map((row) => row.id)).toEqual(["child", "tie-a", "tie-b"]);
  expect(result.pack.excluded).toContainEqual({ id: "parent", reason: "overridden" });
});
it("holds oversized pinned items without truncation and counts Unicode plus wrapper", () => {
  const state = fixture();
  state.knowledge = [item("mandatory", { pinned: true, body: "界".repeat(1000) })];
  const result = buildKnowledgePack(state, { ...input, remainingTokens: 20 });
  expect(result.held).toBe(true);
  expect(result.pinnedOverflow).toEqual(["mandatory"]);
  expect(result.text).toBe("");
  expect(buildKnowledgePack(state, { ...input, excludedIds: ["mandatory"] }).held).toBe(false);
  const fits = buildKnowledgePack(state, input);
  expect(fits.pack.tokenEstimate).toBe(estimateKnowledgeTokens(fits.text));
});
it("uses escaped FTS matching and is unchanged by unrelated project writes", async () => {
  const store = await database();
  const state = fixture();
  store.dispatch("projects", () => ({
    result: {},
    events:
      state.project?.map((row, i) => ({
        eventId: `p${i}`,
        aggregateType: "project",
        aggregateId: String(row.id),
        type: "project.created",
        occurredAt: at,
        payload: row,
      })) ?? [],
  }));
  const save = (id: string, value: KnowledgeItem, revision = 0) =>
    store.dispatch(id, (s) => upsertKnowledge(s, value, revision, { ...context, commandId: id }));
  save("one", item("one"));
  save("two", item("two", { title: "Privacy", body: "Meal privacy" }));
  const build = () => {
    const s = store.snapshot();
    return buildKnowledgePack(s, input, knowledgeMatches(store, s, scope, input.query));
  };
  const before = build();
  for (let i = 0; i < 20; i++)
    save(
      `foreign-${i}`,
      item(`foreign-${i}`, { scope: { type: "project", id: "b" }, body: "meal meal meal privacy" }),
    );
  expect(build()).toEqual(before);
  expect(matchQuery('meal OR " * : (NEAR)')).toBe('"meal" OR "or" OR "near"');
  expect(() => knowledgeMatches(store, store.snapshot(), scope, '"* OR :')).not.toThrow();
  save("edit", item("one", { body: "New body" }), 1);
  save("archive", item("one", { status: "archived" }), 2);
  expect(knowledgeHistory(store, "one").map((row) => row.revision)).toEqual([3, 2, 1]);
  expect(knowledgeHistory(store, "one")[2]?.body).toBe("Use grams for meal accuracy.");
  freezeKnowledgePack(store, "freeze", before.pack);
  expect(freezeKnowledgePack(store, "freeze", before.pack)).toEqual(before.pack);
  expect(frozenKnowledgePack(store, "task")).toEqual(before.pack);
  expect(() => store.database.prepare("UPDATE context_packs SET token_estimate=0").run()).toThrow(
    "immutable",
  );
  const read = readKnowledge(store, { scope, sessionId: "session", taskId: "task" }, "meal");
  expect(JSON.stringify(read.result).length).toBeLessThanOrEqual(4000);
  expect(
    read.result.items.every((row) => row.text.length <= 400 && !row.id.startsWith("foreign")),
  ).toBe(true);
  expect(store.database.prepare("SELECT count(*) AS n FROM knowledge_reads_aux").get()).toEqual({
    n: 1,
  });
});

it("pins promotion provenance to the exact task revision, native session, turn and assistant item", () => {
  const state = fixture();
  state.task = [{ id: "task", projectId: "a", threadId: "task-thread" }];
  state.turn = [{ id: "turn", threadId: "task-thread", sessionId: "native-session" }];
  state.item = [
    { id: "task:r2:input", threadId: "task-thread", turnId: "turn", kind: "user" },
    {
      id: "assistant",
      threadId: "task-thread",
      turnId: "turn",
      kind: "message",
      body: { text: "Use grams. Verified locally." },
    },
  ];
  const source = {
    kind: "task" as const,
    ref: "task",
    taskRevision: 2,
    sessionId: "native-session",
    turnId: "turn",
    itemId: "assistant",
    sourceText: "Use grams.",
    sourceReviewState: "accept",
  };
  const value = item("finding", { sources: [source] });
  expect(upsertKnowledge(state, value, 0, context).result.sources).toEqual([source]);
  expect(() =>
    upsertKnowledge(
      state,
      item("finding", { sources: [{ ...source, taskRevision: 1 }] }),
      0,
      context,
    ),
  ).toThrow("provenance_revision_mismatch");
  expect(() =>
    upsertKnowledge(
      state,
      item("finding", { sources: [{ ...source, sessionId: "foreign" }] }),
      0,
      context,
    ),
  ).toThrow("provenance_mismatch");
  expect(() =>
    upsertKnowledge(
      state,
      item("finding", { sources: [{ ...source, sourceText: "Invented" }] }),
      0,
      context,
    ),
  ).toThrow("provenance_mismatch");
});
