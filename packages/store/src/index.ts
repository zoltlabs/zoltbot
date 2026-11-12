import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type Migration, migrate } from "./migrations.js";
import { SqliteDriver } from "./sqlite-driver.js";
import { Store } from "./store.js";

export type { SqlDriver, SqlStatement, SqlTransaction } from "./driver.js";
export { SqliteDriver } from "./sqlite-driver.js";
export * from "./store.js";
export async function openStore(
  file: string,
  options: { additionalMigrations?: Migration[] } = {},
): Promise<Store> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new SqliteDriver(file);
  chmodSync(file, 0o600);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  try {
    await migrate(database, file, options.additionalMigrations);
    return new Store(database);
  } catch (error) {
    if (database.open) database.close();
    throw error;
  }
}
export { bundledMigrations, type Migration } from "./migrations.js";

export { acquireOwnerLock } from "./owner-lock.js";
