import { migrateDriver, Store } from "@zoltbot/store/portable";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { SqliteDriver } from "../../store/src/sqlite-driver.js";
import { CellSqlDriver, type CellStorage } from "./sql-driver.js";

function fixture() {
  const sqlite = new SqliteDriver(":memory:");
  const statements: string[] = [];
  const storage: CellStorage = {
    sql: {
      exec(sql, ...bindings) {
        statements.push(sql);
        let statement: Database.Statement;
        try {
          statement = sqlite.prepare(sql);
        } catch (error) {
          if (!(error instanceof RangeError) || !error.message.includes("more than one statement"))
            throw error;
          sqlite.exec(sql);
          return [];
        }
        if (statement.reader) return statement.all(...bindings) as Record<string, unknown>[];
        statement.run(...bindings);
        return [];
      },
    },
    transactionSync: (fn) => sqlite.transaction(fn).immediate(),
  };
  return { sqlite, statements, driver: new CellSqlDriver(storage), storage };
}

it("runs bundled migrations and durable command receipts through the cell driver", () => {
  const f = fixture();
  try {
    migrateDriver(f.driver);
    const store = new Store(f.driver);
    const receipt = store.dispatch("one", () => ({ events: [], result: "accepted" }));
    expect(
      store.dispatch("one", () => {
        throw new Error("must not run");
      }),
    ).toEqual(receipt);
    expect(store.snapshot()).toEqual({});
    expect(f.statements.some((sql) => /^BEGIN|^COMMIT|^SAVEPOINT/.test(sql))).toBe(false);
  } finally {
    f.sqlite.close();
  }
});
it("reports direct changes rather than trigger writes and rolls back atomically", () => {
  const f = fixture();
  try {
    f.driver.exec(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY); CREATE TABLE audit(id INTEGER); CREATE TRIGGER record AFTER INSERT ON sample BEGIN INSERT INTO audit VALUES(NEW.id); END;",
    );
    expect(f.driver.prepare("INSERT INTO sample VALUES(?)").run(1)).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    expect(() =>
      f.driver
        .transaction(() => {
          expect(f.driver.inTransaction).toBe(true);
          f.driver.prepare("INSERT INTO sample VALUES(?)").run(2);
          throw new Error("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
    expect(f.driver.inTransaction).toBe(false);
    expect(f.driver.prepare("SELECT * FROM sample").all()).toEqual([{ id: 1 }]);
    expect(f.driver.prepare("SELECT * FROM audit").all()).toEqual([{ id: 1 }]);
  } finally {
    f.sqlite.close();
  }
});
it("keeps connection state per object and leaves platform storage open on close", () => {
  const f = fixture();
  const other = fixture();
  try {
    f.driver.pragma("journal_mode = WAL");
    f.driver.pragma("busy_timeout = 5000");
    f.driver.pragma("foreign_keys = ON");
    f.driver.pragma("wal_checkpoint(TRUNCATE)");
    expect(f.statements).toEqual([]);
    expect(f.driver.pragma("user_version", { simple: true })).toBe(0);
    f.driver.transaction(() => expect(other.driver.inTransaction).toBe(false))();
    f.driver.close();
    expect(f.sqlite.open).toBe(true);
    expect(f.driver.open).toBe(false);
    expect(other.driver.open).toBe(true);
    expect(() => f.driver.exec("SELECT 1")).toThrow("store_closed");
  } finally {
    f.sqlite.close();
    other.sqlite.close();
  }
});
