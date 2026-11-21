// M1: the ranking must find more of the expected memories than the ranking it replaced.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DomainState } from "@zoltbot/core";
import type { KnowledgeItem } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { knowledgeMatches } from "./repository.js";
import { matchQuery, queryTerms, rankKnowledge } from "./retrieval.js";

type Entry = [string, KnowledgeItem["kind"], string, string, string, string[]];
const set = JSON.parse(
  readFileSync(new URL("./fixtures/retrieval-set.json", import.meta.url), "utf8"),
) as { now: string; entries: Entry[]; queries: [string, string[]][] };
const scope = { type: "project" as const, id: "p" };
const owner = { kind: "human" as const, id: "owner" };
const items: KnowledgeItem[] = set.entries.map(([id, kind, day, title, body, tags]) => ({
  id,
  scope,
  kind,
  title,
  body,
  tags,
  owner,
  writer: owner,
  verification: "human",
  status: "active",
  sources: [],
  revision: 1,
  createdAt: `${day}T00:00:00Z`,
  updatedAt: `${day}T00:00:00Z`,
}));
const state: DomainState = {
  project: [
    {
      id: "p",
      name: "p",
      goal: "",
      instructions: "",
      constraints: "",
      roots: [],
      hierarchyDepth: 3,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: set.now,
    },
  ],
  knowledge: items,
};

let dir: string, store: Store;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "zolt-retrieval-"));
  store = await openStore(path.join(dir, "zoltbot.db"));
  store.dispatch("seed", () => ({
    result: null,
    events: items.map((item, index) => ({
      eventId: `seed:${index}`,
      aggregateType: "knowledge",
      aggregateId: item.id,
      type: "knowledge.created",
      occurredAt: item.updatedAt,
      payload: item,
    })),
  }));
  // The search it replaced: one column, no stemming.
  store.database.exec("CREATE VIRTUAL TABLE old_fts USING fts5(id UNINDEXED, text)");
  const insert = store.database.prepare("INSERT INTO old_fts(id,text) VALUES(?,?)");
  for (const item of items)
    insert.run(item.id, `${item.title} ${item.body} ${item.tags.join(" ")}`);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function oldRanking(query: string) {
  const terms = queryTerms(query);
  const matched = new Set(
    (
      store.database
        .prepare("SELECT id FROM old_fts WHERE old_fts MATCH ?")
        .all(terms.map((term) => `"${term}"`).join(" OR ")) as { id: string }[]
    ).map((row) => row.id),
  );
  const score = (item: KnowledgeItem) =>
    terms.reduce(
      (sum, term) =>
        sum +
        Number(queryTerms(item.title).includes(term)) * 5 +
        Number(queryTerms(item.tags.join(" ")).includes(term)) * 3 +
        Number(queryTerms(item.body).includes(term)),
      0,
    );
  return items
    .filter((item) => matched.has(item.id))
    .sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt))
    .map((item) => item.id);
}
const newRanking = (query: string) =>
  rankKnowledge(
    state,
    scope,
    query,
    set.now,
    knowledgeMatches(store, state, scope, query),
  ).items.map((item) => item.id);
/** Share of each query's expected entries found in the top three, averaged over queries. */
function recall(rank: (query: string) => string[]) {
  const misses: string[] = [];
  const total = set.queries.reduce((sum, [query, expected]) => {
    const top = rank(query).slice(0, 3);
    const found = expected.filter((id) => top.includes(id)).length;
    if (found < expected.length) misses.push(`${query} → ${top.join(",")}`);
    return sum + found / expected.length;
  }, 0);
  return { score: total / set.queries.length, misses };
}

it("has 50 entries and 30 queries", () => {
  expect(set.entries).toHaveLength(50);
  expect(set.queries).toHaveLength(30);
});

it("finds more of the expected memories than the old ranking", () => {
  const before = recall(oldRanking);
  const after = recall(newRanking);
  expect(after.score, after.misses.join("\n")).toBeGreaterThan(before.score);
  expect(after.score, after.misses.join("\n")).toBeGreaterThanOrEqual(0.9);
});

it("matches plural forms and quarter names", () => {
  expect(newRanking("invoices").slice(0, 3).sort()).toEqual(["k01", "k02", "k03"]);
  expect(newRanking("Q3")[0]).toBe("k04");
  expect(newRanking("third quarter")).toContain("k04");
  expect(matchQuery("fourth quarter")).toContain('"q4"');
});

it("ranks the newer of two matching facts first", () => {
  const ranked = newRanking("standup time");
  expect(ranked.indexOf("k12")).toBeLessThan(ranked.indexOf("k13"));
});

it("keeps a verified constraint ahead of a newer unverified note with the same words", () => {
  const verified = {
    ...items[0],
    id: "a",
    title: "Deploy freeze",
    body: "No deploys in December.",
    kind: "constraint" as const,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const note = {
    ...verified,
    id: "b",
    kind: "lesson" as const,
    verification: "unverified" as const,
    updatedAt: set.now,
  };
  const ranked = rankKnowledge(
    { ...state, knowledge: [note, verified] },
    scope,
    "deploy freeze",
    set.now,
  );
  expect(ranked.items.map((item) => item.id)).toEqual(["a", "b"]);
});
