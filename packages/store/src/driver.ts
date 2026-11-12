/** The synchronous SQLite surface shared by the Mac and an org cell. */
export interface SqlStatement {
  get(...bindings: unknown[]): unknown;
  all(...bindings: unknown[]): unknown[];
  run(...bindings: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
export interface SqlTransaction<T> {
  (): T;
  immediate(): T;
}
export interface SqlDriver {
  prepare(sql: string): SqlStatement;
  exec(sql: string): unknown;
  transaction<T>(fn: () => T): SqlTransaction<T>;
  readonly inTransaction: boolean;
  /** SELECT changes(), excluding trigger and index writes. */
  readonly changes: number;
  readonly name: string;
  readonly open: boolean;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  close(): void;
}
