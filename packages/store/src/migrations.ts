import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  sql: string;
}
export function bundledMigrations(): Migration[] {
  const dir = new URL("../migrations/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort()
    .map((file) => ({
      version: Number(file.slice(0, 3)),
      sql: readFileSync(new URL(file, dir), "utf8"),
    }));
}
export async function migrate(
  database: Database.Database,
  file: string,
  additional: Migration[] = [],
) {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  const current = exists
    ? (
        database
          .prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")
          .get() as { version: number }
      ).version
    : 0;
  const migrations = [...bundledMigrations(), ...additional].sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const m of migrations) {
    if (versions.has(m.version)) throw new Error("migration_failed: duplicate version");
    versions.add(m.version);
  }
  // The pre-launch chain was replaced, not upgraded. Never silently accept its version numbers.
  if (
    exists &&
    !database.prepare("SELECT name FROM sqlite_master WHERE name='schema_baseline'").get()
  )
    throw new Error("migration_failed: prelaunch_database_reset_required");
  const pending = migrations.filter((m) => m.version > current);
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
    database.transaction(() => {
      for (const m of pending) {
        database.exec(m.sql);
        database
          .prepare("INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES(?,?)")
          .run(m.version, new Date().toISOString());
      }
    })();
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
