import type { SqlDriver, SqlStatement, SqlTransaction } from "@zoltbot/store/portable";

/** Structural platform types keep the driver testable without a Worker runtime. */
export interface CellSql {
  exec(sql: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
}
export interface CellStorage {
  sql: CellSql;
  transactionSync<T>(fn: () => T): T;
}

/** Each instance belongs to exactly one Durable Object. No connection state is shared. */
export class CellSqlDriver implements SqlDriver {
  readonly name = ":cell:";
  private depth = 0;
  private closed = false;
  constructor(private readonly storage: CellStorage) {}
  get inTransaction(): boolean {
    return this.depth > 0;
  }
  get open(): boolean {
    return !this.closed;
  }
  private query(sql: string, bindings: unknown[] = []): Record<string, unknown>[] {
    if (this.closed) throw new Error("store_closed");
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  get changes(): number {
    return Number(this.query("SELECT changes() AS n")[0]?.n ?? 0);
  }
  prepare(sql: string): SqlStatement {
    return {
      get: (...bindings) => this.query(sql, bindings)[0],
      all: (...bindings) => this.query(sql, bindings),
      run: (...bindings) => {
        this.query(sql, bindings);
        return {
          changes: this.changes,
          lastInsertRowid: this.query("SELECT last_insert_rowid() AS n")[0]?.n as number | bigint,
        };
      },
    };
  }
  exec(sql: string): void {
    this.query(sql);
  }
  transaction<T>(fn: () => T): SqlTransaction<T> {
    const invoke = () => {
      if (this.closed) throw new Error("store_closed");
      // transactionSync owns commit, rollback and nesting. SQL BEGIN is forbidden on the platform.
      return this.storage.transactionSync(() => {
        this.depth++;
        try {
          return fn();
        } finally {
          this.depth--;
        }
      });
    };
    return Object.assign(invoke, { immediate: invoke });
  }
  pragma(sql: string, options?: { simple?: boolean }): unknown {
    // These Mac connection settings are managed by the platform. Never send them to SQLite.
    if (/^\s*(?:journal_mode|busy_timeout|foreign_keys|wal_checkpoint)\b/i.test(sql)) return [];
    const rows = this.query(`PRAGMA ${sql}`);
    return options?.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }
  close(): void {
    // Closing a store must not close or delete the Durable Object's platform-owned storage.
    this.closed = true;
  }
}
