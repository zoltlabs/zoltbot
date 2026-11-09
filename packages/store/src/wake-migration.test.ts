import path from "node:path";
import { handle, saveWake } from "@zoltbot/core";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { openStore } from "./index.js";

it("upgrades an existing baseline database without losing chats, then persists a wait across reopen", async () => {
  const f = await runtimeFixture();
  const at = "2026-11-09T12:00:00.000Z",
    actor = { kind: "human" as const, id: "owner" };
  f.store.dispatch("job", (s) =>
    handle(
      s,
      {
        type: "update",
        kind: "session",
        id: "session",
        changes: {
          background: [{ id: "tests", kind: "shell", description: "Tests", state: "running" }],
        },
      },
      { commandId: "job", at, actor },
    ),
  );
  f.queue("message", "Keep this conversation");
  const before = f.store.snapshot();
  // Restore the exact schema shape that existed before migration 002.
  f.store.database.exec(
    "DROP TABLE wakes; ALTER TABLE threads DROP COLUMN wake_pending; ALTER TABLE threads DROP COLUMN wake_unread_at; DELETE FROM schema_migrations WHERE version=2;",
  );
  f.store.close();
  let store = await openStore(path.join(f.root, "store.db"));
  try {
    expect(store.snapshot()).toEqual(before);
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.dispatch("wait", (s) =>
      saveWake(
        s,
        {
          threadId: "thread",
          condition: { kind: "job", sessionId: "session", jobId: "tests", outcome: "finished" },
          fallbackAt: "2026-11-10T12:00:00.000Z",
          behavior: "resume",
          continuation: "Review test results",
        },
        "wake",
        { commandId: "wait", at, actor },
      ),
    );
    store.close();
    store = await openStore(path.join(f.root, "store.db"));
    expect(store.record("wake", "wake")).toMatchObject({
      status: "waiting",
      continuation: "Review test results",
    });
    expect(store.record("thread", "thread")?.wakePending).toBe(true);
    expect(store.record("item", "message")).toBeDefined();
    store.rebuild();
    expect(store.record("wake", "wake")?.status).toBe("waiting");
  } finally {
    store.close();
    f.close();
  }
});
