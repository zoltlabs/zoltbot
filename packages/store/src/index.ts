import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type DomainEvent, type EntityKind, parseEvent } from "@zoltbot/protocol";
import Database from "better-sqlite3";
import { type Migration, migrate } from "./migrations.js";
import { applyProjection, tableMap } from "./projections.js";

export type Snapshot = Record<string, Record<string, unknown>[]>;
export interface ItemScope {
  ids: readonly string[];
  latestInThread?: string;
  controlsInThread?: string;
}
export type KillPoint = "before_events" | "after_events" | "after_projections" | "after_receipt";
export interface Receipt<T = unknown> {
  result: T;
  fromSeq: number;
  toSeq: number;
}
export class Store {
  constructor(readonly database: Database.Database) {}
  receipt<T = unknown>(commandId: string): Receipt<T> | undefined {
    const previous = this.database
      .prepare("SELECT result FROM command_receipts WHERE command_id=?")
      .get(commandId) as { result: string } | undefined;
    return previous ? (JSON.parse(previous.result) as Receipt<T>) : undefined;
  }
  dispatch<T>(
    commandId: string,
    produce: (state: Snapshot) => { events: DomainEvent[]; result: T },
    options: { killPoint?: KillPoint; items?: ItemScope } = {},
  ): Receipt<T> {
    if (!commandId) throw new Error("command id required");
    if (this.database.inTransaction) throw new Error("nested dispatch is not allowed");
    const kill = (point: KillPoint) => {
      if (options.killPoint === point) throw new Error(`kill point: ${point}`);
    };
    return this.database
      .transaction(() => {
        const previous = this.receipt<T>(commandId);
        if (previous) return previous;
        const output = produce(this.commandSnapshot(options.items));
        const events = output.events.map((e) => parseEvent({ ...e, commandId }));
        const start = this.lastSeq();
        kill("before_events");
        const append = this.database.prepare(
          "INSERT INTO events(event_id,command_id,aggregate_type,aggregate_id,type,occurred_at,payload) VALUES(?,?,?,?,?,?,?)",
        );
        for (const e of events)
          append.run(
            e.eventId,
            commandId,
            e.aggregateType,
            e.aggregateId,
            e.type,
            e.occurredAt,
            JSON.stringify(e.payload),
          );
        kill("after_events");
        for (const e of events) applyProjection(this.database, e);
        kill("after_projections");
        const receipt = {
          result: output.result,
          fromSeq: events.length ? start + 1 : start,
          toSeq: this.lastSeq(),
        };
        this.database
          .prepare("INSERT INTO command_receipts(command_id,result,created_at) VALUES(?,?,?)")
          .run(commandId, JSON.stringify(receipt), new Date().toISOString());
        kill("after_receipt");
        return receipt;
      })
      .immediate();
  }
  lastSeq(): number {
    return (
      this.database.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM events").get() as { n: number }
    ).n;
  }
  eventsSince(seq: number, limit = 1000): DomainEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?")
      .all(seq, limit) as {
      seq: number;
      event_id: string;
      command_id: string | null;
      aggregate_type: string;
      aggregate_id: string;
      type: string;
      occurred_at: string;
      payload: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      eventId: r.event_id,
      ...(r.command_id ? { commandId: r.command_id } : {}),
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      type: r.type,
      occurredAt: r.occurred_at,
      payload: JSON.parse(r.payload),
    }));
  }
  snapshot(kinds?: readonly EntityKind[]): Snapshot {
    const state: Snapshot = {};
    if (kinds?.length === 0) return state;
    for (const row of this.database
      .prepare(
        `SELECT kind,body FROM projection_records${kinds ? ` WHERE kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY kind,id`,
      )
      .all(...(kinds ?? [])) as { kind: string; body: string }[]) {
      const entries = state[row.kind] ?? [];
      entries.push(JSON.parse(row.body));
      state[row.kind] = entries;
    }
    return state;
  }
  record(kind: EntityKind, id: string): Record<string, unknown> | undefined {
    const row = this.database
      .prepare("SELECT body FROM projection_records WHERE kind=? AND id=?")
      .get(kind, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Record<string, unknown>) : undefined;
  }
  /** Each thread's newest item of one kind, for Inbox previews. Walks the (thread_id, seq) index backwards. */
  latestItems(threadIds: readonly string[], kind: string): Map<string, Record<string, unknown>> {
    const statement = this.database.prepare(
      `SELECT p.body FROM projection_records p WHERE p.kind='item'
        AND p.id=(SELECT id FROM items WHERE thread_id=? AND kind=? ORDER BY seq DESC LIMIT 1)`,
    );
    const result = new Map<string, Record<string, unknown>>();
    for (const id of threadIds) {
      const row = statement.get(id, kind) as { body: string } | undefined;
      if (row) result.set(id, JSON.parse(row.body) as Record<string, unknown>);
    }
    return result;
  }
  /** Queue and control metadata without loading message history. */
  runtimeSnapshot(threadId: string): Snapshot {
    return this.commandSnapshot({ ids: [], latestInThread: threadId, controlsInThread: threadId });
  }
  /** Scoped item dependencies are explicit. Other domain kinds remain complete. */
  private commandSnapshot(scope?: ItemScope): Snapshot {
    if (!scope) return this.snapshot();
    if (scope.ids.length > 100) throw new Error("invalid_item_scope");
    const kinds = (Object.keys(tableMap) as EntityKind[]).filter((kind) => kind !== "item");
    const state = this.snapshot(kinds);
    const placeholders = scope.ids.length ? scope.ids.map(() => "?").join(",") : "NULL";
    // A UNION of indexed lookups: an OR of these subqueries walks every item row.
    const rows = this.database
      .prepare(`SELECT body FROM (
      SELECT p.id, p.body FROM projection_records p WHERE p.kind='item' AND p.id IN (${placeholders})
      UNION SELECT p.id, p.body FROM projection_records p WHERE p.kind='item'
        AND p.id=(SELECT id FROM items WHERE thread_id=? ORDER BY seq DESC,id DESC LIMIT 1)
      UNION SELECT p.id, p.body FROM projection_records p WHERE p.kind='item'
        AND p.id IN (SELECT id FROM items WHERE thread_id=? AND kind IN ('user','note'))
    ) ORDER BY id`)
      .all(...scope.ids, scope.latestInThread ?? null, scope.controlsInThread ?? null) as {
      body: string;
    }[];
    if (rows.length) state.item = rows.map((row) => JSON.parse(row.body));
    return state;
  }
  rebuild() {
    this.database.transaction(() => {
      this.database.pragma("defer_foreign_keys = ON");
      for (const table of [...new Set(Object.values(tableMap))].reverse())
        this.database.exec(`DELETE FROM "${table}"`);
      this.database.exec(
        "DELETE FROM workflows; DELETE FROM artifacts_fts; DELETE FROM items_fts; DELETE FROM knowledge_fts; DELETE FROM projection_records;",
      );
      let seq = 0;
      while (true) {
        const batch = this.eventsSince(seq);
        if (!batch.length) break;
        for (const e of batch) applyProjection(this.database, e);
        seq = batch.at(-1)?.seq ?? seq;
      }
    })();
  }
  close() {
    if (this.database.open) this.database.close();
  }
}
export async function openStore(
  file: string,
  options: { additionalMigrations?: Migration[] } = {},
): Promise<Store> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new Database(file);
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
