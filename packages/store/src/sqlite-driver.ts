import Database from "better-sqlite3";
import type { SqlDriver } from "./driver.js";

/** Keep native statements and transactions intact for existing Mac callers. */
export class SqliteDriver extends Database implements SqlDriver {
  get changes(): number {
    return (this.prepare("SELECT changes() AS n").get() as { n: number }).n;
  }
}
