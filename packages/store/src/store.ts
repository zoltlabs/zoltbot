import { type DomainEvent, type EntityKind, parseEvent } from "@zoltbot/protocol";
import type { SqlDriver } from "./driver.js";
import { applyProjection, tableMap } from "./projections.js";
import { type ReadScope, scopedRead } from "./scoped-read.js";

export type { ReadScope } from "./scoped-read.js";

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
  constructor(readonly database: SqlDriver) {}
  receipt<T = unknown>(commandId: string): Receipt<T> | undefined {
    const previous = this.database
      .prepare("SELECT result FROM command_receipts WHERE command_id=?")
      .get(commandId) as { result: string } | undefined;
    return previous ? (JSON.parse(previous.result) as Receipt<T>) : undefined;
  }
  dispatch<T>(
    commandId: string,
    produce: (state: Snapshot) => { events: DomainEvent[]; result: T },
    options: {
      killPoint?: KillPoint;
      items?: ItemScope;
      scope?: ReadScope;
      kinds?: readonly EntityKind[];
    } = {},
  ): Receipt<T> {
    if (!commandId) throw new Error("command id required");
    this.assertReadable();
    if (this.database.inTransaction) throw new Error("nested dispatch is not allowed");
    const kill = (point: KillPoint) => {
      if (options.killPoint === point) throw new Error(`kill point: ${point}`);
    };
    try {
      return this.database
        .transaction(() => {
          const previous = this.receipt<T>(commandId);
          if (previous) return previous;
          const output = produce(
            options.scope
              ? this.read(options.scope, options.kinds)
              : this.commandSnapshot(options.items),
          );
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
    } catch (error) {
      if (
        error instanceof Error &&
        (/SQLITE_FULL|database or disk is full/i.test(error.message) ||
          ("code" in error && error.code === "SQLITE_FULL"))
      )
        throw new Error("storage_full: The store is full. This command was not saved.", {
          cause: error,
        });
      throw error;
    }
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
  read(scope: ReadScope, kinds?: readonly EntityKind[]): Snapshot {
    this.assertReadable();
    return scopedRead(this.database, scope, kinds);
  }
  snapshot(kinds?: readonly EntityKind[]): Snapshot {
    this.assertReadable();
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
    this.assertReadable();
    const row = this.database
      .prepare("SELECT body FROM projection_records WHERE kind=? AND id=?")
      .get(kind, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Record<string, unknown>) : undefined;
  }
  /** Each thread's newest item of one kind, for Inbox previews. Walks the (thread_id, seq) index backwards. */
  latestItems(threadIds: readonly string[], kind: string): Map<string, Record<string, unknown>> {
    this.assertReadable();
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
    this.assertReadable();
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
  private assertReadable() {
    if (this.rebuildProgress()) throw new Error("store_rebuilding");
  }
  rebuildProgress(): { cursor: number; target: number } | undefined {
    return this.database.prepare("SELECT cursor,target FROM store_rebuild WHERE id=1").get() as
      | { cursor: number; target: number }
      | undefined;
  }
  private clearProjections() {
    this.database.pragma("defer_foreign_keys = ON");
    for (const table of [...new Set(Object.values(tableMap))].reverse())
      this.database.exec(`DELETE FROM "${table}"`);
    this.database.exec(
      "DELETE FROM workflows; DELETE FROM artifacts_fts; INSERT INTO items_fts(items_fts) VALUES('delete-all'); DELETE FROM knowledge_fts; DELETE FROM projection_rows;",
    );
  }
  /** An undefined cursor starts a rebuild; null means the last bounded step committed. */
  rebuildStep(cursor: number | undefined, maxEvents: number): number | null {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 5000)
      throw new Error("invalid_rebuild_batch");
    return this.database
      .transaction(() => {
        let progress = this.rebuildProgress();
        if (cursor === undefined) {
          if (progress) throw new Error("store_rebuilding");
          progress = { cursor: 0, target: this.lastSeq() };
          this.clearProjections();
          this.database
            .prepare("INSERT INTO store_rebuild(id,cursor,target) VALUES(1,0,?)")
            .run(progress.target);
        } else if (!progress || cursor !== progress.cursor) throw new Error("stale_rebuild_cursor");
        let next = progress.cursor;
        let bytes = 0;
        for (let count = 0; count < maxEvents; count++) {
          // An event can contain a large transcript body. Hydrate one at a time,
          // and stop this step after one MiB rather than retaining a whole batch.
          const event = this.eventsSince(next, 1)[0];
          if (!event) break;
          applyProjection(this.database, event);
          next = event.seq ?? next;
          bytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
          if (bytes >= 1048576) break;
        }
        if (next >= progress.target) {
          this.database.prepare("DELETE FROM store_rebuild WHERE id=1").run();
          return null;
        }
        this.database.prepare("UPDATE store_rebuild SET cursor=? WHERE id=1").run(next);
        return next;
      })
      .immediate();
  }
  rebuild() {
    this.assertReadable();
    this.database.transaction(() => {
      this.clearProjections();
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
