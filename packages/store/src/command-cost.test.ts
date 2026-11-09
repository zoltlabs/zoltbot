import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { DomainEvent } from "@zoltbot/protocol";
import { afterEach, expect, it } from "vitest";
import { openStore, type Store } from "./index.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function location() {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/command-cost-"));
  roots.push(dir);
  return path.join(dir, "test.db");
}
const at = "2026-11-06T12:00:00.000Z";
let events = 0;
const make = (aggregateType: string, id: string, payload: Record<string, unknown>) =>
  ({
    eventId: `event-${++events}`,
    aggregateType,
    aggregateId: id,
    type: `${aggregateType}.created`,
    occurredAt: at,
    payload,
  }) as DomainEvent;
const item = (id: string, seq: number, kind = "message", text = `Synthetic message ${id}`) =>
  make("item", id, {
    id,
    threadId: "h",
    seq,
    kind,
    phase: "final",
    body: { text },
    createdAt: at,
    updatedAt: at,
  });
const seedEvents = [
  make("agentDefinition", "d", {
    id: "d",
    displayName: "Synthetic",
    adapter: "local",
    binaryNames: ["local"],
    versionCommand: ["--version"],
    launch: { command: "local", args: [], env: {} },
    testedVersions: "*",
    defaults: { permissionProfile: "workspace_write" },
    staticCapabilities: {},
    nativeSessionRoots: [],
    experimental: false,
  }),
  make("agent", "p", {
    id: "p",
    name: "Synthetic",
    avatar: "S",
    definitionId: "d",
    kind: "profile",
    permissionProfile: "workspace_write",
    instructions: "",
    hidden: false,
    archived: false,
    createdAt: at,
    updatedAt: at,
  }),
  make("thread", "h", {
    id: "h",
    agentId: "p",
    kind: "main",
    title: "Synthetic",
    titleSource: "human",
    pinned: false,
    archived: false,
    lastActivityAt: at,
    createdAt: at,
  }),
];
function grow(s: Store, from: number, to: number) {
  for (let start = from; start < to; start += 500)
    s.dispatch(`history-${start}`, () => ({
      events: Array.from({ length: Math.min(500, to - start) }, (_, i) =>
        item(`i${start + i}`, start + i + 1, (start + i) % 50 === 0 ? "note" : "message"),
      ),
      result: null,
    }));
}
/** Every statement a scoped item command runs, with its query plan. */
function commandPlans(s: Store, commandId: string) {
  const statements: { sql: string; args: unknown[] }[] = [];
  const prepare = s.database.prepare.bind(s.database);
  s.database.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        statements.push({ sql, args });
        return original(...args);
      };
    }
    return statement;
  }) as typeof s.database.prepare;
  try {
    s.dispatch(
      commandId,
      (state) => ({
        events: [item("i1", 2, "message", `Edited by ${commandId} ${state.item?.length}`)],
        result: null,
      }),
      { items: { ids: ["i1"], latestInThread: "h", controlsInThread: "h" } },
    );
  } finally {
    s.database.prepare = prepare;
  }
  return statements
    .filter(({ sql }) => !sql.startsWith("PRAGMA"))
    .map(({ sql, args }) => ({
      sql,
      plan: (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((row) => row.detail)
        .join("; "),
    }));
}

it("keeps a scoped item command off full scans as history grows", async () => {
  const s = await openStore(location());
  stores.push(s);
  s.dispatch("seed", () => ({ events: seedEvents, result: null }));
  grow(s, 0, 100);
  const small = commandPlans(s, "edit-small");
  grow(s, 100, 3000);
  const large = commandPlans(s, "edit-large");
  expect(large).toEqual(small);
  // A table scan, an FTS lookup with no constraint, or a walk of every row of one projection kind
  // reads rows in proportion to history. Non-item kinds are still loaded whole by design.
  const scans = large.filter(
    ({ sql, plan }) =>
      /SCAN (?!\(|items_fts VIRTUAL TABLE INDEX 0:=)|VIRTUAL TABLE INDEX 0:(;|$)/.test(plan) ||
      (sql.includes("kind='item'") && /\(kind=\?\)/.test(plan)),
  );
  expect(scans).toEqual([]);
  expect(large.some(({ plan }) => plan.includes("items_controls"))).toBe(true);
  const search = s.database
    .prepare("SELECT id FROM items_fts WHERE items_fts MATCH ? ORDER BY id")
    .all('"Edited by edit-large"');
  expect(search).toEqual([{ id: "i1" }]);
  expect(s.database.prepare("SELECT count(*) AS n FROM items_fts").get()).toEqual({ n: 3000 });
});

it("preserves indexed full-text row identity across a canonical-store reopen", async () => {
  const file = location();
  const original = await openStore(file);
  original.dispatch("seed", () => ({ events: seedEvents, result: null }));
  grow(original, 0, 600);
  original.close();
  const reopened = await openStore(file);
  stores.push(reopened);
  expect(
    reopened.database
      .prepare(
        "SELECT count(*) AS n FROM items_fts f JOIN items i ON i.rowid=f.rowid AND i.id=f.id",
      )
      .get(),
  ).toEqual({ n: 600 });
  expect(
    reopened.database
      .prepare("SELECT id FROM items_fts WHERE items_fts MATCH ?")
      .all('"Synthetic message i42"'),
  ).toEqual([{ id: "i42" }]);
  reopened.dispatch("edit", () => ({
    events: [item("i42", 43, "message", "Rewritten text")],
    result: null,
  }));
  expect(
    reopened.database
      .prepare("SELECT id FROM items_fts WHERE items_fts MATCH ?")
      .all('"Synthetic message i42"'),
  ).toEqual([]);
  expect(reopened.database.prepare("SELECT count(*) AS n FROM items_fts").get()).toEqual({
    n: 600,
  });
  expect(
    reopened.database.prepare("SELECT name FROM sqlite_master WHERE name='items_controls'").get(),
  ).toEqual({ name: "items_controls" });
});
