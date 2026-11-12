import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { SqlDriver } from "./driver.js";
import { type Migration, migrateDriver, pendingMigrations } from "./migrate-driver.js";

export { bundledMigrations, type Migration } from "./migrate-driver.js";

export async function migrate(database: SqlDriver, file: string, additional: Migration[] = []) {
  const pending = pendingMigrations(database, additional);
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'")
    .get();
  const current = exists
    ? (
        database
          .prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")
          .get() as { version: number }
      ).version
    : 0;
  if (!pending.length) return;
  let backup: string | undefined;
  if (current > 0) {
    const dir = path.join(path.dirname(file), "backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    backup = path.join(dir, `zoltbot-${current}-${Date.now()}.db`);
    const checkpoint = database.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (checkpoint.some((row) => row.busy !== 0))
      throw new Error("migration_failed: database is busy during backup");
    copyFileSync(file, backup);
    for (const old of readdirSync(dir)
      .filter((f) => f.endsWith(".db"))
      .sort()
      .slice(0, -5))
      rmSync(path.join(dir, old));
  }
  try {
    migrateDriver(database, additional);
  } catch (error) {
    database.close();
    if (backup && existsSync(backup)) {
      rmSync(`${file}-wal`, { force: true });
      rmSync(`${file}-shm`, { force: true });
      copyFileSync(backup, file);
    }
    throw new Error(
      `migration_failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}
