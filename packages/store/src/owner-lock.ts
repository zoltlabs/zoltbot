import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** A schema free sidecar transaction holds an OS backed lease, released even after SIGKILL. */
export function acquireOwnerLock(file: string): { release(): void } {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("owner_lock_symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = new Database(file, { timeout: 0 });
  try {
    chmodSync(file, 0o600);
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: string }).code)))
      throw new Error("daemon_already_running");
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}
