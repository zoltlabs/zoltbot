import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { DomainEvent } from "@zoltbot/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { bundledMigrations, openStore, type Store } from "./index.js";

const roots: string[] = [];
const stores: Store[] = [];
function location() {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/store-"));
  roots.push(dir);
  return path.join(dir, "test.db");
}
async function open(file = location()) {
  const store = await openStore(file);
  stores.push(store);
  return store;
}
const at = "2026-10-27T12:00:00.000Z";
function event(id: string, name = "Builder"): DomainEvent {
  return {
    eventId: `event-${id}`,
    aggregateType: "agentDefinition",
    aggregateId: id,
    type: "agentDefinition.created",
    occurredAt: at,
    payload: {
      id,
      displayName: name,
      adapter: "local",
      binaryNames: ["local"],
      versionCommand: ["--version"],
      launch: { command: "local", args: [], env: {} },
      testedVersions: "*",
      defaults: { permissionProfile: "workspace_write" },
      staticCapabilities: {},
      nativeSessionRoots: [],
      experimental: false,
    },
  };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
describe("SQLite store and dispatch", () => {
  it("reads only requested projection kinds without changing complete snapshots or sharing mutable rows", async () => {
    const s = await open();
    s.dispatch("subset-seed", () => ({
      events: [
        event("a"),
        {
          eventId: "setting",
          aggregateType: "settings",
          aggregateId: "guard",
          type: "settings.created",
          occurredAt: at,
          payload: { key: "guard", value: true },
        },
      ],
      result: {},
    }));
    const selected = s.snapshot(["settings"]);
    expect(selected).toEqual({ settings: [{ key: "guard", value: true }] });
    expect(s.snapshot([])).toEqual({});
    if (selected.settings?.[0]) selected.settings[0].value = false;
    expect(s.snapshot(["settings"]).settings?.[0]?.value).toBe(true);
    expect(s.snapshot().agentDefinition).toHaveLength(1);
  });
  it("uses the migration path, WAL, and foreign keys", async () => {
    const s = await open();
    expect(s.database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(s.database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(s.database.prepare("select count(*) as n from schema_migrations").get()).toEqual({
      n: bundledMigrations().length,
    });
    for (const name of [
      "agents",
      "projects",
      "tasks",
      "stage_runs",
      "routines",
      "external_actions_aux",
      "knowledge_items",
      "items_fts",
      "knowledge_fts",
    ])
      expect(s.database.prepare("select name from sqlite_master where name=?").get(name)).toEqual({
        name,
      });
  });
  it("returns the persisted receipt without re-running a repeated command", async () => {
    const s = await open();
    let calls = 0;
    const produce = () => {
      calls++;
      return { events: [event("a")], result: { id: "a" } };
    };
    expect(s.dispatch("cmd", produce).result).toEqual({ id: "a" });
    expect(s.dispatch("cmd", produce).result).toEqual({ id: "a" });
    expect(calls).toBe(1);
    expect(s.eventsSince(0)).toHaveLength(1);
  });
  it.each([
    "before_events",
    "after_events",
    "after_projections",
    "after_receipt",
  ] as const)("rolls back at kill point %s", async (point) => {
    const file = location();
    const s = await open(file);
    expect(() =>
      s.dispatch("cmd", () => ({ events: [event("a")], result: "a" }), { killPoint: point }),
    ).toThrow(/kill point/);
    s.close();
    const restored = await open(file);
    expect(restored.eventsSince(0)).toEqual([]);
    expect(restored.snapshot()).toEqual({});
    expect(restored.dispatch("cmd", () => ({ events: [event("a")], result: "ok" })).result).toBe(
      "ok",
    );
  });
  it("rebuilds identical projections after deterministic random command sequences", async () => {
    const s = await open();
    let seed = 17;
    for (let i = 0; i < 80; i++) {
      seed = (seed * 16807) % 2147483647;
      const id = `d${seed % 13}`;
      const e = event(`${i}`, `name-${seed}`);
      e.aggregateId = id;
      (e.payload as { id: string }).id = id;
      s.dispatch(`cmd-${i}`, () => ({ events: [e], result: { i } }));
    }
    const before = s.snapshot();
    const rows = s.database.prepare("select * from agent_definitions order by id").all();
    s.rebuild();
    expect(s.snapshot()).toEqual(before);
    expect(s.database.prepare("select * from agent_definitions order by id").all()).toEqual(rows);
  });
  it("creates a valid backup and restores original data after a failed upgrade", async () => {
    const file = location();
    const s = await open(file);
    s.dispatch("cmd", () => ({ events: [event("a")], result: null }));
    s.close();
    const before = readFileSync(file);
    await expect(
      openStore(file, {
        additionalMigrations: [
          {
            version: Math.max(...bundledMigrations().map((m) => m.version)) + 1,
            sql: "ALTER TABLE agents ADD COLUMN sample TEXT; THIS IS INVALID SQL;",
          },
        ],
      }),
    ).rejects.toThrow(/migration_failed/);
    expect(readFileSync(file)).toEqual(before);
    const reopened = await open(file);
    expect(reopened.eventsSince(0)).toHaveLength(1);
    expect(readdirSync(path.join(path.dirname(file), "backups")).length).toBeGreaterThan(0);
    expect(reopened.database.prepare("pragma table_info(agents)").all()).not.toContainEqual(
      expect.objectContaining({ name: "sample" }),
    );
  });
  it("rejects invalid events without appending them", async () => {
    const s = await open();
    expect(() =>
      s.dispatch("cmd", () => ({ events: [{ ...event("a"), type: "unknown" }], result: null })),
    ).toThrow(/Uncatalogued/);
    expect(s.eventsSince(0)).toHaveLength(0);
  });
});

it("maintains item search and rebuilds its index", async () => {
  const s = await open();
  const def = event("local");
  const make = (kind: string, id: string, payload: unknown): DomainEvent => ({
    eventId: `e-${kind}-${id}`,
    aggregateType: kind,
    aggregateId: id,
    type: `${kind}.created`,
    occurredAt: at,
    payload,
  });
  const profile = {
    id: "p",
    name: "Builder",
    avatar: "B",
    definitionId: "local",
    kind: "profile",
    permissionProfile: "workspace_write",
    instructions: "",
    hidden: false,
    archived: false,
    createdAt: at,
    updatedAt: at,
  };
  const thread = {
    id: "h",
    agentId: "p",
    kind: "main",
    title: "Search test",
    titleSource: "human",
    pinned: false,
    archived: false,
    lastActivityAt: at,
    createdAt: at,
  };
  const item = {
    id: "i",
    threadId: "h",
    seq: 1,
    kind: "message",
    phase: "final",
    body: { text: "Find the unique needleword here" },
    createdAt: at,
    updatedAt: at,
  };
  s.dispatch("seed", () => ({
    events: [
      def,
      make("agent", "p", profile),
      make("thread", "h", thread),
      make("item", "i", item),
    ],
    result: null,
  }));
  const search = () =>
    s.database.prepare("SELECT id FROM items_fts WHERE items_fts MATCH 'needleword'").all();
  expect(search()).toEqual([{ id: "i" }]);
  s.rebuild();
  expect(search()).toEqual([{ id: "i" }]);
});

it("rolls back a whole batch when a projection violates a foreign key", async () => {
  const s = await open();
  const broken: DomainEvent = {
    eventId: "bad-profile",
    aggregateType: "agent",
    aggregateId: "p",
    type: "agent.created",
    occurredAt: at,
    payload: {
      id: "p",
      name: "Bad reference",
      avatar: "B",
      definitionId: "absent",
      kind: "profile",
      permissionProfile: "workspace_write",
      instructions: "",
      hidden: false,
      archived: false,
    },
  };
  expect(() =>
    s.dispatch("batch", () => ({ events: [event("good"), broken], result: null })),
  ).toThrow(/FOREIGN KEY/);
  expect(s.eventsSince(0)).toEqual([]);
  expect(s.snapshot()).toEqual({});
});

it("persists pure command outcomes and agrees with the pure projector", async () => {
  const { handle, applyEvents } = await import("@zoltbot/core");
  const s = await open();
  const ctx = { commandId: "domain-create", at, actor: { kind: "human" as const, id: "owner" } };
  const value = event("domain").payload as Record<string, unknown>;
  const outcome = handle({}, { type: "create", kind: "agentDefinition", value }, ctx);
  s.dispatch(ctx.commandId, (state) =>
    handle(state, { type: "create", kind: "agentDefinition", value }, ctx),
  );
  expect(s.snapshot()).toEqual(applyEvents({}, outcome.events));
  const next = { ...ctx, commandId: "domain-update" };
  s.dispatch(next.commandId, (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "agentDefinition",
        id: "domain",
        changes: { displayName: "Updated" },
      },
      next,
    ),
  );
  expect(s.database.prepare("select body from agent_definitions where id=?").get("domain")).toEqual(
    { body: JSON.stringify({ ...value, displayName: "Updated" }) },
  );
});

for (const version of [1, 20])
  it(`rejects a pre-launch migration history at version ${version} without resetting data`, async () => {
    const file = location();
    const original = await openStore(file);
    original.dispatch("keep", () => ({ events: [event("kept")], result: "kept" }));
    original.database.exec(`DROP TABLE schema_baseline; DELETE FROM schema_migrations;`);
    original.database
      .prepare("INSERT INTO schema_migrations VALUES(?,?)")
      .run(version, "synthetic");
    original.close();
    await expect(openStore(file)).rejects.toThrow("prelaunch_database_reset_required");
    const unchanged = new Database(file);
    try {
      expect(unchanged.prepare("SELECT version FROM schema_migrations").all()).toEqual([
        { version },
      ]);
      expect(
        unchanged.prepare("SELECT result FROM command_receipts WHERE command_id='keep'").get(),
      ).toBeDefined();
      expect(
        unchanged.prepare("SELECT name FROM sqlite_master WHERE name='schema_baseline'").get(),
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });
