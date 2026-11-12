import { expect, it, vi } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { openStore } from "./index.js";

it("commits bounded steps, refuses partial reads and writes, and resumes after reopening", async () => {
  const f = await runtimeFixture();
  try {
    for (let i = 0; i < 30; i++) f.queue(`input-${i}`, `Synthetic message ${i}`);
    const expected = f.store.snapshot();
    f.store.rebuild();
    expect(f.store.snapshot()).toEqual(expected);
    const first = f.store.rebuildStep(undefined, 3);
    expect(first).toBe(3);
    expect(f.store.rebuildProgress()?.cursor).toBe(3);
    expect(() => f.store.snapshot()).toThrow("store_rebuilding");
    expect(() => f.store.read({ taskId: "missing" })).toThrow("store_rebuilding");
    expect(() => f.queue("blocked", "Do not write")).toThrow("store_rebuilding");
    const file = f.store.database.name;
    f.store.close();
    const reopened = await openStore(file);
    try {
      let cursor: number | null = first;
      expect(() => reopened.rebuildStep(0, 3)).toThrow("stale_rebuild_cursor");
      while (cursor !== null) cursor = reopened.rebuildStep(cursor, 3);
      expect(reopened.rebuildProgress()).toBeUndefined();
      expect(reopened.snapshot()).toEqual(expected);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
it("reports a full disk without a receipt or partial events and keeps reads available", async () => {
  const f = await runtimeFixture();
  try {
    const seq = f.store.lastSeq();
    const prepare = f.store.database.prepare.bind(f.store.database);
    const spy = vi.spyOn(f.store.database, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO events"))
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      return prepare(sql);
    });
    expect(() => f.queue("full", "Synthetic input")).toThrow("storage_full:");
    spy.mockRestore();
    expect(f.store.lastSeq()).toBe(seq);
    expect(f.store.receipt("full")).toBeUndefined();
    expect(f.store.snapshot().thread).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("limits transcript memory independently of the requested event count", async () => {
  const f = await runtimeFixture();
  try {
    for (let n = 0; n < 4; n++) f.queue(`large-${n}`, "界".repeat(250000));
    const expected = f.store.snapshot();
    const reads = vi.spyOn(f.store, "eventsSince");
    let cursor = f.store.rebuildStep(undefined, 5000);
    expect(cursor).not.toBeNull();
    while (cursor !== null) cursor = f.store.rebuildStep(cursor, 5000);
    expect(reads.mock.calls.every(([, limit]) => limit === 1)).toBe(true);
    expect(f.store.snapshot()).toEqual(expected);
  } finally {
    f.close();
  }
});
