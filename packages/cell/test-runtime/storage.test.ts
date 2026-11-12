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
