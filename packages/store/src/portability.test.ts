import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { bundledMigrations, migrateDriver, Store } from "./portable.js";
import { SqliteDriver } from "./sqlite-driver.js";

it("keeps the checked-in migration bundle current", () => {
  expect(() =>
    execFileSync(process.execPath, ["packages/store/scripts/generate-migrations.mjs", "--check"]),
  ).not.toThrow();
});
it("bundles the portable entry without Node or native SQLite imports", async () => {
  const result = await build({
    entryPoints: ["packages/store/src/portable.ts"],
    bundle: true,
    platform: "browser",
    write: false,
    metafile: true,
  });
  expect(
    Object.keys(result.metafile.inputs).some((file) =>
      /sqlite-driver|owner-lock|node_modules\/better-sqlite3/.test(file),
    ),
  ).toBe(false);
});
it("migrates and dispatches through the portable driver", () => {
  const driver = new SqliteDriver(":memory:");
  try {
    migrateDriver(driver);
    const store = new Store(driver);
    expect(driver.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({
      n: bundledMigrations().length,
    });
    expect(store.dispatch("empty", () => ({ events: [], result: "ok" })).result).toBe("ok");
    expect(driver.changes).toBe(1);
    expect(
      store.dispatch("empty", () => {
        throw new Error("replayed");
      }).result,
    ).toBe("ok");
  } finally {
    driver.close();
  }
});
