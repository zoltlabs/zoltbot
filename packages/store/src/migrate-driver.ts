import type { SqlDriver } from "./driver.js";
import { migrations } from "./migrations.generated.js";
import { clearProjectionCache } from "./projections.js";

export interface Migration {
  version: number;
  sql: string;
}
export function bundledMigrations(): Migration[] {
  return migrations.map((migration) => ({ ...migration }));
}
/** Cell callers use platform recovery; the Mac supplies its filesystem backup hook. */
export function migrateDriver(database: SqlDriver, additional: Migration[] = []) {
  const pending = pendingMigrations(database, additional);
  database
    .transaction(() => {
      for (const migration of pending) {
        database.exec(migration.sql);
        database
          .prepare("INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES(?,?)")
          .run(migration.version, new Date().toISOString());
      }
    })
    .immediate();
  clearProjectionCache(database);
}
export function pendingMigrations(database: SqlDriver, additional: Migration[] = []): Migration[] {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
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
  const applied = exists
    ? new Set(
        (
          database.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]
        ).map((r) => r.version),
      )
    : new Set<number>();
  const pending = migrations.filter((m) => !applied.has(m.version));
  return pending;
}
