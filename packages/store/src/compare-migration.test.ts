import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { bundledMigrations, openStore } from "./index.js";

it("initializes Compare in the canonical schema and reopens without reapplying it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-initial-"));
  const file = path.join(root, "store.db");
  try {
    expect(bundledMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = await openStore(file);
      try {
        for (const name of ["compares", "compare_members"])
          expect(
            store.database.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name),
          ).toEqual({ name });
        expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(store.database.prepare("SELECT version FROM schema_migrations").all()).toEqual([
          { version: 1 },
          { version: 2 },
          { version: 3 },
          { version: 4 },
          { version: 5 },
        ]);
        store.rebuild();
        expect(store.snapshot(["compare", "compareMember"])).toEqual({});
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
