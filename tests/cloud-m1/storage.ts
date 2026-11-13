import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { SqliteDriver } from "../../packages/store/src/sqlite-driver.js";

/** Read only this fixture's persisted SQLite files; never attach to an owner's app database. */
export async function cellStorageCounts(directory: string) {
  const totals = { events: 0, projects: 0, cell_identity: 0 };
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const handle = await open(file, "r"),
        header = Buffer.alloc(16);
      try {
        await handle.read(header, 0, 16, 0);
      } finally {
        await handle.close();
      }
      if (header.toString("utf8") !== "SQLite format 3\0") continue;
      const database = new SqliteDriver(file, {
        readonly: true,
        fileMustExist: true,
        timeout: 1000,
      });
      try {
        const tables = new Set(
          (
            database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
              name: string;
            }[]
          ).map((row) => row.name),
        );
        for (const table of ["events", "projects", "cell_identity"] as const)
          if (tables.has(table))
            totals[table] += (
              database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
            ).n;
      } finally {
        database.close();
      }
    }
  };
  await walk(directory);
  return totals;
}
