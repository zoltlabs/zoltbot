import { randomUUID } from "node:crypto";
import { AgentEventSchema, parse } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { RuntimeObservation } from "../runtime-observer.js";
import type { RunnerOutbox } from "./outbox.js";

/** A cache transaction owns each observation until its fsynced JSONL copy is durable. */
export class ObservationJournal {
  private readonly id: string;
  constructor(
    private readonly options: {
      store: Store;
      outbox: RunnerOutbox;
      threadId: string;
      guard(value: unknown): void;
    },
  ) {
    const db = options.store.database;
    this.id = db
      .transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS runner_observation_source (id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runner_observation_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);`);
        const rows = db.prepare("SELECT id FROM runner_observation_source").all() as {
          id: string;
        }[];
        if (rows.length > 1) throw new Error("runner_observation_corrupt");
        const id = rows[0]?.id ?? randomUUID();
        if (!rows.length) db.prepare("INSERT INTO runner_observation_source(id) VALUES(?)").run(id);
        return id;
      })
      .immediate();
    const highest = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name='runner_observation_queue'")
      .get() as { seq: number } | undefined;
    options.outbox.bindSource(this.id, highest?.seq ?? 0);
  }
  /** Call inside the same Store.dispatch produce callback that projects this event. */
  record(observation: RuntimeObservation) {
    const db = this.options.store.database;
    if (!db.inTransaction) throw new Error("runner_observation_transaction_required");
    const payload = this.encode(observation);
    db.prepare("INSERT INTO runner_observation_queue(payload) VALUES(?)").run(payload);
  }
  recordTransient(observation: RuntimeObservation) {
    this.options.store.database.transaction(() => this.record(observation)).immediate();
  }
  private encode(observation: RuntimeObservation) {
    if (observation.threadId !== this.options.threadId || !observation.sessionId)
      throw new Error("runner_observation_scope_conflict");
    parse(AgentEventSchema, observation.event);
    try {
      this.options.guard(observation);
    } catch {
      throw new Error("runner_observation_private_value");
    }
    const payload = JSON.stringify(observation);
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024 - 4096)
      throw new Error("runner_event_too_large");
    return payload;
  }
  flush() {
    const db = this.options.store.database;
    if (db.inTransaction) throw new Error("runner_observation_flush_in_transaction");
    // A single row bounds memory independently of the accumulated transcript.
    while (true) {
      const row = db
        .prepare("SELECT id,payload FROM runner_observation_queue ORDER BY id LIMIT 1")
        .get() as { id: number; payload: string } | undefined;
      if (!row) return;
      const observation = JSON.parse(row.payload) as RuntimeObservation;
      this.encode(observation);
      this.options.outbox.appendSource(this.id, row.id, observation);
      // A crash here leaves the row pending. appendSource recognizes that exact last copy.
      db.prepare("DELETE FROM runner_observation_queue WHERE id=?").run(row.id);
    }
  }
}
