import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openStore, type Store } from "./index.js";

const dirs: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const owner = { kind: "human", id: "local-owner" };
const knowledge = {
  id: "k1",
  scope: { type: "project", id: "p" },
  kind: "constraint",
  title: "Grams",
  body: "Use grams.",
  tags: [],
  owner,
  status: "active",
  sources: [],
  revision: 2,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
};

it("initializes knowledge metadata and snapshots without a backfill", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zolt-knowledge-initial-"));
  dirs.push(dir);
  const store = await openStore(path.join(dir, "zoltbot.db"));
  stores.push(store);
  const expected = { ...knowledge, verification: "human", writer: owner };
  store.dispatch("knowledge-initial", () => ({
    events: [
      {
        eventId: "e1",
        aggregateType: "knowledge",
        aggregateId: "k1",
        type: "knowledge.created",
        occurredAt: knowledge.updatedAt,
        payload: expected,
      },
    ],
    result: null,
  }));
  expect(store.record("knowledge", "k1")).toEqual(expected);
  const snapshots = store.database
    .prepare("SELECT revision, body FROM knowledge_revision_snapshots WHERE item_id='k1'")
    .all() as { revision: number; body: string }[];
  expect(snapshots.map((row) => [row.revision, JSON.parse(row.body)])).toEqual([[2, expected]]);
  expect(
    store.database.prepare("SELECT verification, writer FROM knowledge_items WHERE id='k1'").get(),
  ).toEqual({ verification: "human", writer: JSON.stringify(owner) });
  store.rebuild();
  expect(store.record("knowledge", "k1")).toEqual(expected);
  expect(store.database.prepare("SELECT id FROM knowledge_fts").all()).toEqual([{ id: "k1" }]);
});

it("never clears session taint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zolt-014-"));
  dirs.push(dir);
  const store = await openStore(path.join(dir, "zoltbot.db"));
  stores.push(store);
  store.database
    .prepare("INSERT INTO knowledge_session_taint(session_id,cause,at) VALUES('s','fetch','x')")
    .run();
  expect(() => store.database.prepare("DELETE FROM knowledge_session_taint").run()).toThrow(
    "taint_is_permanent",
  );
});

it("rebuilds knowledge search with stemming from the saved entries (015)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zolt-015-"));
  dirs.push(dir);
  const store = await openStore(path.join(dir, "zoltbot.db"));
  stores.push(store);
  const entry = {
    ...knowledge,
    title: "Invoice numbering",
    body: "Invoices restart each January.",
    tags: ["billing", "finance"],
    verification: "human",
    writer: owner,
  };
  store.dispatch("knowledge-015", () => ({
    events: [
      {
        eventId: "e1",
        aggregateType: "knowledge",
        aggregateId: "k1",
        type: "knowledge.created",
        occurredAt: knowledge.updatedAt,
        payload: entry,
      },
    ],
    result: null,
  }));
  // Put the table back as it was before 015, then run 015 on it.
  store.database.exec(
    "DROP TABLE knowledge_fts; CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, text);",
  );
  const sql = readFileSync(
    new URL("../migrations/015-knowledge-search.sql", import.meta.url),
    "utf8",
  );
  store.database.exec(sql);
  const search = (query: string) =>
    store.database
      .prepare("SELECT id, tags FROM knowledge_fts WHERE knowledge_fts MATCH ?")
      .all(query);
  expect(search('"invoice"')).toEqual([{ id: "k1", tags: "billing finance" }]);
  expect(search('"restarting"')).toEqual([{ id: "k1", tags: "billing finance" }]);
  expect(search('"payroll"')).toEqual([]);
});
