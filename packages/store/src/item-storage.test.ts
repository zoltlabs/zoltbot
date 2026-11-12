import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { bundledMigrations, openStore } from "./index.js";
import { SqliteDriver } from "./sqlite-driver.js";

it("upgrades a copy of a large legacy fixture, stores bodies once, and preserves history and search", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "item-storage-"));
  const file = path.join(root, "original.db");
  const copy = path.join(root, "upgraded.db");
  const database = new SqliteDriver(file);
  const at = "2026-11-11T00:00:00Z";
  const text = `uniquemessage ${"synthetic ".repeat(240)}`;
  try {
    for (const migration of bundledMigrations().filter((m) => m.version < 8)) {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version, at);
    }
    database.exec(`INSERT INTO agent_definitions VALUES('d','builtin','{}','${at}');
      INSERT INTO agents(id,name,definition_id,created_at,updated_at) VALUES('p','Synthetic','d','${at}','${at}');
      INSERT INTO threads(id,agent_id,kind,last_activity_at,created_at) VALUES('h','p','main','${at}','${at}');`);
    database.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        const id = `i${i}`;
        const body = { text: `${text} ${i}` };
        const payload = {
          id,
          threadId: "h",
          seq: i + 1,
          kind: "message",
          body,
          createdAt: at,
          updatedAt: at,
        };
        database
          .prepare(
            "INSERT INTO events(event_id,aggregate_type,aggregate_id,type,occurred_at,payload) VALUES(?,'item',?,'item.created',?,?)",
          )
          .run(`event-${id}`, id, at, JSON.stringify(payload));
        database
          .prepare("INSERT INTO projection_records VALUES('item',?,?)")
          .run(id, JSON.stringify(payload));
        database
          .prepare(
            "INSERT INTO items(id,thread_id,seq,kind,body,created_at,updated_at) VALUES(?,'h',?,'message',?,?,?)",
          )
          .run(id, i + 1, JSON.stringify(body), at, at);
        database
          .prepare(
            "INSERT INTO items_fts(rowid,id,thread_id,text) SELECT rowid,id,thread_id,body FROM items WHERE id=?",
          )
          .run(id);
      }
    })();
    database.close();
    copyFileSync(file, copy);
    const store = await openStore(copy);
    try {
      expect(store.database.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 3000 });
      expect(
        store.database
          .prepare("SELECT id FROM items_fts WHERE items_fts MATCH 'uniquemessage'")
          .all(),
      ).toHaveLength(3000);
      expect(store.record("item", "i42")?.body).toEqual({ text: `${text} 42` });
      expect(store.database.prepare("SELECT body FROM items WHERE id='i42'").get()).toEqual({
        body: JSON.stringify({ text: `${text} 42` }),
      });
      expect(store.eventsSince(42, 1)[0]?.payload).toMatchObject({ body: { text: `${text} 42` } });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS n FROM item_records WHERE instr(body,'uniquemessage')>0")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS n FROM projection_rows WHERE instr(body,'uniquemessage')>0")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        store.database
          .prepare("SELECT name FROM sqlite_master WHERE name='items_fts_content'")
          .get(),
      ).toBeUndefined();
      expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const original = new SqliteDriver(file);
      try {
        expect(original.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()).toEqual({
          n: 7,
        });
      } finally {
        original.close();
      }
    } finally {
      store.close();
    }
  } finally {
    if (database.open) database.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
