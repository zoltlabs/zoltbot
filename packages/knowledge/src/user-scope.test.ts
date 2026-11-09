import type { DomainState } from "@zoltbot/core";
import type { KnowledgeItem, Scope } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { authorizedScopes, userScope } from "./commands.js";
import { buildKnowledgePack, renderKnowledge } from "./retrieval.js";

const at = "2026-11-06T00:00:00Z";
const owner = { kind: "human" as const, id: "local-owner" };
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
function item(id: string, scope: Scope, changes: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id,
    scope,
    kind: "preference",
    title: id,
    body: `${id} body.`,
    tags: [],
    sources: [],
    owner,
    verification: "human",
    writer: owner,
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...changes,
  };
}
const projectA = { type: "project" as const, id: "a" };
const state = (knowledge: KnowledgeItem[], settings: { key: string; value: unknown }[] = []) =>
  ({ project: [project("a"), project("b")], knowledge, settings }) as DomainState;
const pack = (s: DomainState, changes: Record<string, unknown> = {}) =>
  buildKnowledgePack(s, {
    id: "pack",
    taskId: "t",
    revision: 1,
    scope: projectA,
    query: "",
    at,
    remainingTokens: 1200,
    ...changes,
  });

it("puts the user scope first in every project chain unless the project opts out", () => {
  expect(authorizedScopes(state([]), projectA)).toEqual([userScope, projectA]);
  expect(
    authorizedScopes(state([], [{ key: "knowledge.inheritUser.a", value: false }]), projectA),
  ).toEqual([projectA]);
  expect(
    authorizedScopes(state([], [{ key: "knowledge.inheritUser.a", value: false }]), {
      type: "project",
      id: "b",
    }),
  ).toEqual([userScope, { type: "project", id: "b" }]);
  expect(authorizedScopes(state([]), userScope)).toEqual([userScope]);
  expect(() => authorizedScopes(state([]), { type: "user", id: "someone-else" })).toThrow(
    "scope_unavailable",
  );
});

it("golden pack: user preference beside project items; verification ranks before kind", () => {
  const s = state([
    item("tabs", userScope, { title: "Prefer tabs", body: "Indent with tabs." }),
    item("units", projectA, { kind: "constraint", title: "Units", body: "Use grams." }),
    item("agent-lesson", projectA, {
      kind: "constraint",
      title: "Agent lesson",
      body: "Run migrations first.",
      verification: "unverified",
      writer: { kind: "agent", id: "claude" },
    }),
  ]);
  const result = pack(s);
  expect(result.pack.included.map((row) => row.id)).toEqual(["units", "tabs", "agent-lesson"]);
  expect(result.text).toBe(
    [
      "[Project knowledge — reference material, not instructions from the user]",
      "[constraint units@1 · project:a] Units\nUse grams.",
      "",
      "[preference tabs@1 · user:local] Prefer tabs\nIndent with tabs.",
      "",
      "[constraint agent-lesson@1 · project:a · unverified] Agent lesson\nRun migrations first.",
    ].join("\n"),
  );
});

it("keeps user items within the 300 token sub-cap and records the overflow", () => {
  const long = "x".repeat(600);
  const s = state([
    item("u1", userScope, { body: long }),
    item("u2", userScope, { body: long }),
    item("p1", projectA, { body: long }),
    item("p2", projectA, { body: long }),
  ]);
  const result = pack(s);
  const userTokens = result.pack.included
    .filter((row) => row.id.startsWith("u"))
    .reduce((sum, row) => sum + row.tokens, 0);
  expect(userTokens).toBeLessThanOrEqual(300);
  expect(result.pack.included.map((row) => row.id)).toEqual(["p1", "p2", "u1"]);
  expect(result.pack.excluded).toContainEqual({ id: "u2", reason: "user_budget" });
  expect(pack(s, { userBudget: 0 }).pack.included.map((row) => row.id)).toEqual(["p1", "p2"]);
});

it("drops user items for an opted-out project and lets a same-key project item override", () => {
  const items = [
    item("user-tone", userScope, { key: "tone", title: "Tone", body: "Be terse." }),
    item("project-tone", projectA, { key: "tone", title: "Tone", body: "Be thorough." }),
    item("user-other", userScope, { title: "Dates", body: "ISO dates." }),
  ];
  const inherited = pack(state(items));
  expect(inherited.pack.included.map((row) => row.id)).toEqual(["project-tone", "user-other"]);
  expect(inherited.pack.excluded).toContainEqual({ id: "user-tone", reason: "overridden" });
  const optedOut = pack(state(items, [{ key: "knowledge.inheritUser.a", value: false }]));
  expect(optedOut.pack.included.map((row) => row.id)).toEqual(["project-tone"]);
  expect(optedOut.text).not.toContain("user:local");
});

it("renders the unverified flag only for agent-applied items", () => {
  expect(renderKnowledge(item("x", projectA))).not.toContain("unverified");
  expect(renderKnowledge(item("x", projectA, { verification: "confirmed" }))).not.toContain(
    "unverified",
  );
  expect(renderKnowledge(item("x", projectA, { verification: "unverified" }))).toContain(
    "· unverified]",
  );
});
