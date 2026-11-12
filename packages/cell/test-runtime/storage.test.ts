import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { handle } from "@zoltbot/core";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CellSqlDriver } from "../src/sql-driver.js";

it("migrates the real platform SQLite and preserves receipts through eviction", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  const create = async () =>
    runInDurableObject(stub, (_instance, state) => {
      const driver = new CellSqlDriver(state.storage);
      migrateDriver(driver);
      const store = new Store(driver);
      return store.dispatch(
        "project:create",
        (snapshot) =>
          handle(
            snapshot,
            {
              type: "create",
              kind: "project",
              value: {
                id: "project",
                name: "Test",
                goal: "",
                instructions: "",
                constraints: "",
                roots: [],
                hierarchyDepth: 0,
                tags: [],
                requireCodeReview: false,
                skipFinalGateWhenReviewed: false,
                archived: false,
                createdAt: "2026-11-11T00:00:00.000Z",
              },
            },
            {
              commandId: "project:create",
              at: "2026-11-11T00:00:00.000Z",
              actor: { kind: "human", id: "member" },
            },
          ),
        { scope: { projectId: "project" } },
      );
    });
  const first = await create();
  await evictDurableObject(stub);
  expect(await create()).toEqual(first);
  expect(first.toSeq).toBe(1);
});

it("continues an alarm-driven projection rebuild after object eviction", async () => {
  const { vi } = await import("vitest");
  const { runDurableObjectAlarm } = await import("cloudflare:test");
  const mocked = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ active: true }));
  try {
    const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (_instance, state) => {
      const driver = new CellSqlDriver(state.storage);
      migrateDriver(driver);
      driver.exec(
        "CREATE TABLE cell_identity(id INTEGER PRIMARY KEY,org_id TEXT,user_id TEXT); INSERT INTO cell_identity VALUES(1,'org','member')",
      );
      const store = new Store(driver);
      for (let n = 0; n < 205; n++) {
        const commandId = `project:${n}`;
        store.dispatch(
          commandId,
          (snapshot) =>
            handle(
              snapshot,
              n === 0
                ? {
                    type: "create",
                    kind: "project",
                    value: {
                      id: "project",
                      name: "0",
                      goal: "",
                      instructions: "",
                      constraints: "",
                      roots: [],
                      hierarchyDepth: 0,
                      tags: [],
                      requireCodeReview: false,
                      skipFinalGateWhenReviewed: false,
                      archived: false,
                      createdAt: "2026-11-11T00:00:00Z",
                    },
                  }
                : { type: "update", kind: "project", id: "project", changes: { name: String(n) } },
              { commandId, at: "2026-11-11T00:00:00Z", actor: { kind: "human", id: "member" } },
            ),
          { scope: { projectId: "project" }, kinds: ["project"] },
        );
      }
      await state.storage.put("cell:rebuild", true);
      await state.storage.setAlarm(Date.now() + 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const cursor = await runInDurableObject(stub, async (_instance, state) => {
      const progress = new Store(new CellSqlDriver(state.storage)).rebuildProgress();
      await state.storage.setAlarm(Date.now() + 60000);
      return progress?.cursor;
    });
    expect(cursor).toBe(100);
    await evictDurableObject(stub);
    // An automatic alarm may finish the last batch between manual invocations.
    for (let n = 0; n < 3; n++) {
      const progress = await runInDurableObject(stub, (_instance, state) =>
        new Store(new CellSqlDriver(state.storage)).rebuildProgress(),
      );
      if (!progress) break;
      await runDurableObjectAlarm(stub);
    }
    expect(
      await runInDurableObject(stub, (_instance, state) => {
        const store = new Store(new CellSqlDriver(state.storage));
        return {
          progress: store.rebuildProgress(),
          name: store.record("project", "project")?.name,
          seq: store.lastSeq(),
          receipt: store.receipt("project:204")?.toSeq,
        };
      }),
    ).toEqual({ progress: undefined, name: "204", seq: 205, receipt: 205 });
  } finally {
    mocked.mockRestore();
  }
});

it("reads scoped metadata from a cell with more than one GB of message events", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  const result = await runInDurableObject(stub, async (_instance, state) => {
    const driver = new CellSqlDriver(state.storage);
    migrateDriver(driver);
    const store = new Store(driver);
    const context = {
      commandId: "small",
      at: "2026-11-11T00:00:00Z",
      actor: { kind: "human" as const, id: "member" },
    };
    store.dispatch(
      "small",
      (snapshot) =>
        handle(
          snapshot,
          {
            type: "create",
            kind: "project",
            value: {
              id: "small",
              name: "Small project",
              goal: "",
              instructions: "",
              constraints: "",
              roots: [],
              hierarchyDepth: 0,
              tags: [],
              requireCodeReview: false,
              skipFinalGateWhenReviewed: false,
              archived: false,
              createdAt: context.at,
            },
          },
          context,
        ),
      { scope: { projectId: "small" }, kinds: ["project"] },
    );
    const payload = JSON.stringify({
      id: "history",
      threadId: "historical-thread",
      seq: 1,
      kind: "message",
      body: { text: "x".repeat(1048576) },
      createdAt: context.at,
      updatedAt: context.at,
    });
    for (let n = 0; n < 1000; n++) {
      const id = `history:${n}`;
      driver.transaction(() => {
        driver
          .prepare(
            "INSERT INTO events(event_id,aggregate_type,aggregate_id,type,occurred_at,payload) VALUES(?,'item',?,'item.created',?,json_set(?,'$.id',?,'$.seq',?))",
          )
          .run(id, id, context.at, payload, id, n + 1);
        driver
          .prepare(
            "INSERT INTO projection_rows(kind,id,body,body_event_id) VALUES('item',?,json_remove(json_set(?,'$.id',?,'$.seq',?),'$.body'),?)",
          )
          .run(id, payload, id, n + 1, id);
      })();
      if (n % 16 === 15) await state.storage.sync();
    }
    await state.storage.sync();
    const bytes = (
      driver.prepare("SELECT sum(length(payload)) AS bytes FROM events").get() as { bytes: number }
    ).bytes;
    const scoped = store.read({ projectId: "small" }, ["project", "task", "thread"]);
    return { bytes, scoped };
  });
  expect(result.bytes).toBeGreaterThan(1000000000);
  expect(result.scoped.project?.map((row) => row.id)).toEqual(["small"]);
  expect(result.scoped.item).toBeUndefined();
}, 120000);
