import { createRequire } from "node:module";
import Database from "better-sqlite3";
import type { SqlDriver } from "./driver.js";

/** Keep native statements and transactions intact for existing Mac callers. */
export class SqliteDriver extends Database implements SqlDriver {
  get changes(): number {
    return (this.prepare("SELECT changes() AS n").get() as { n: number }).n;
  }
}

/** better-sqlite3's entry file, for a child process that opens SQLite on its own. */
export function sqliteModulePath(): string {
  return createRequire(import.meta.url).resolve("better-sqlite3");
}
