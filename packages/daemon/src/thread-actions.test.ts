import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { type EntityKind, parseEvent } from "@zoltbot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../../ui/src/connection.js";
import { type Daemon, startDaemon } from "./index.js";

const at = "2026-11-08T10:00:00Z";
let root = "";
let daemon: Daemon | undefined;
let client: DaemonClient | undefined;
let seq = 0;

function seed(kind: EntityKind, value: Record<string, unknown>) {
  if (!daemon) throw new Error("no daemon");
  const id = `seed-${++seq}`;
  daemon.store.dispatch(id, () => ({
    events: [
      parseEvent({
        eventId: `${id}:0`,
        commandId: id,
        aggregateType: kind,
        aggregateId: String(value.id ?? value.key),
        type: `${kind}.updated`,
        occurredAt: at,
        payload: value,
      }),
    ],
    result: {},
  }));
}

async function callRpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  commandId?: string,
): Promise<T> {
  if (!client) throw new Error("no client");
  return (await client.call(method, params, commandId)) as T;
}

describe("thread actions", () => {
  beforeEach(async () => {
    mkdirSync(".cache/tests", { recursive: true });
    root = mkdtempSync(path.resolve(".cache/tests/thread-actions-"));
    daemon = await startDaemon({ dataDir: root });
    seq = 0;
    seed("agentDefinition", {
      id: "claude",
      displayName: "Claude",
      adapter: "acp",
      binaryNames: [],
      versionCommand: [],
      launch: { command: "echo", args: [], env: {} },
      testedVersions: "fixture",
      defaults: { permissionProfile: "read_only" },
      staticCapabilities: {
        sessions: { load: false, fork: false, resume: false },
        models: { choices: [] },
        efforts: [],
        permissions: [],
        compaction: false,
      },
      nativeSessionRoots: [],
      experimental: false,
    });
    seed("agent", {
      id: "agent-1",
      name: "Builder",
      definitionId: "claude",
      roleText: "",
      permissionProfile: "read_only",
      instructions: "",
      kind: "profile",
      avatar: "B",
      hidden: false,
      archived: false,
      createdAt: at,
      updatedAt: at,
    });
    seed("project", {
      id: "proj-1",
      name: "Zolt",
      goal: "Build carefully",
      instructions: "",
      constraints: "",
      roots: [],
      hierarchyDepth: 2,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    });
    seed("thread", {
      id: "chat-1",
      agentId: "agent-1",
      projectId: "proj-1",
      node: { type: "project", id: "proj-1" },
      kind: "main",
      title: "Original title",
      titleSource: "auto",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    });
    client = new DaemonClient(async () => ({ url: daemon!.url, token: daemon!.token }));
    await client.start();
  });

  afterEach(async () => {
    client?.stop();
    await daemon?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("renames and pins a chat via RPC and syncs to clients", async () => {
    const renamed = await callRpc<Record<string, unknown>>(
      "thread.rename",
      { id: "chat-1", title: "  Renamed chat  " },
      "cmd-rename-1",
    );
    expect(renamed).toMatchObject({ id: "chat-1", title: "Renamed chat", titleSource: "human" });
    await expect(
      callRpc("thread.rename", { id: "chat-1", title: "   " }, "cmd-rename-empty"),
    ).rejects.toThrow("invalid_params");

    const pinned = await callRpc<Record<string, unknown>>(
      "thread.pin",
      { id: "chat-1", pinned: true },
      "cmd-pin-1",
    );
    expect(pinned).toMatchObject({ id: "chat-1", pinned: true });
    const unpinned = await callRpc<Record<string, unknown>>(
      "thread.pin",
      { id: "chat-1", pinned: false },
      "cmd-pin-2",
    );
    expect(unpinned).toMatchObject({ id: "chat-1", pinned: false });
  });

  it("marks turnless chats unread and read cleanly", async () => {
    const unread = await callRpc<Record<string, unknown>>(
      "thread.markUnread",
      { id: "chat-1" },
      "cmd-unread-turnless",
    );
    expect(unread.lastReadAt).toBeUndefined();
    expect(typeof unread.wakeUnreadAt).toBe("string");

    const inbox = await callRpc<{
      items: { mailbox: string; unread: boolean; thread: { id: string } }[];
    }>("thread.inbox", {});
    expect(inbox.items).toEqual([
      expect.objectContaining({
        mailbox: "review",
        unread: true,
        thread: expect.objectContaining({ id: "chat-1" }),
      }),
    ]);

    const read = await callRpc<Record<string, unknown>>(
      "thread.markRead",
      { id: "chat-1", at: "2026-11-08T10:01:00Z" },
      "cmd-read-turnless",
    );
    expect(String(read.lastReadAt) >= String(unread.wakeUnreadAt)).toBe(true);
  });

  it("archives and unarchives a chat, cancelling wakes and refusing task threads", async () => {
    seed("wake", {
      id: "wake-1",
      threadId: "chat-1",
      revision: 1,
      status: "waiting",
      condition: { kind: "topic", projectId: "proj-1", phrase: "deploy" },
      label: "Wait for deploy",
      fallbackAt: "2099-01-01T00:00:00Z",
      behavior: "inbox",
      continuation: "Continue",
      permissionStamp: "{}",
      createdAt: at,
      updatedAt: at,
    });
    await expect(
      callRpc("thread.archive", { id: "chat-1", confirmed: false }, "cmd-arch-noconfirm"),
    ).rejects.toThrow("confirmation_required");

    const archived = await callRpc<{ ok: boolean }>(
      "thread.archive",
      { id: "chat-1", confirmed: true },
      "cmd-arch-1",
    );
    expect(archived).toEqual({ ok: true });
    expect(daemon?.store.record("thread", "chat-1")).toMatchObject({ archived: true });
    expect(daemon?.store.record("wake", "wake-1")).toMatchObject({ status: "cancelled" });

    const unarchived = await callRpc<Record<string, unknown>>(
      "thread.unarchive",
      { id: "chat-1" },
      "cmd-unarch-1",
    );
    expect(unarchived).toMatchObject({ id: "chat-1", archived: false });

    seed("thread", {
      id: "task-thread",
      agentId: "agent-1",
      projectId: "proj-1",
      taskId: "task-1",
      kind: "task",
      title: "Task chat",
      titleSource: "auto",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    });
    await expect(
      callRpc("thread.archive", { id: "task-thread", confirmed: true }, "cmd-arch-task"),
    ).rejects.toThrow("invalid_state");
    await expect(
      callRpc("thread.delete", { id: "task-thread", confirmed: true }, "cmd-del-task"),
    ).rejects.toThrow("invalid_state");
  });

  it("deletes a chat, clears FTS5 and child tables, purges events, preserves rebuild, and syncs live clients", async () => {
    seed("session", {
      id: "sess-1",
      threadId: "chat-1",
      provider: "claude",
      cwd: "/tmp",
      state: "ready",
      capabilities: {},
      startedAt: at,
    });
    seed("turn", {
      id: "turn-1",
      threadId: "chat-1",
      sessionId: "sess-1",
      status: "completed",
      origin: "human",
      startedAt: at,
      endedAt: at,
    });
    seed("item", {
      id: "item-1",
      threadId: "chat-1",
      turnId: "turn-1",
      seq: 1,
      kind: "message",
      body: { text: "unique_needle_for_deletion_test" },
      createdAt: at,
      updatedAt: at,
    });
    expect(
      daemon?.store.database
        .prepare("SELECT id FROM items_fts WHERE items_fts MATCH 'unique_needle_for_deletion_test'")
        .all(),
    ).toHaveLength(1);

    await expect(
      callRpc("thread.delete", { id: "chat-1", confirmed: false }, "cmd-del-noconfirm"),
    ).rejects.toThrow("confirmation_required");

    const deleted = await callRpc<{ ok: boolean }>(
      "thread.delete",
      { id: "chat-1", confirmed: true },
      "cmd-del-1",
    );
    expect(deleted).toEqual({ ok: true });

    // FTS5 index, SQL tables, projections, and historical events are cleaned up.
    expect(daemon?.store.record("thread", "chat-1")).toBeUndefined();
    expect(daemon?.store.record("turn", "turn-1")).toBeUndefined();
    expect(daemon?.store.record("item", "item-1")).toBeUndefined();
    expect(
      daemon?.store.database
        .prepare("SELECT id FROM items_fts WHERE items_fts MATCH 'unique_needle_for_deletion_test'")
        .all(),
    ).toHaveLength(0);
    expect(
      daemon?.store.database
        .prepare("SELECT count(*) AS n FROM events WHERE aggregate_id='chat-1'")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      daemon?.store.database
        .prepare(
          "SELECT count(*) AS n FROM events WHERE json_extract(payload,'$.threadId')='chat-1'",
        )
        .get(),
    ).toEqual({ n: 0 });

    const beforeRebuild = daemon?.store.snapshot();
    daemon?.store.rebuild();
    expect(daemon?.store.snapshot()).toEqual(beforeRebuild);

    // Wait briefly for the live client event listener to apply thread.deleted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snap = client?.state.snapshot.entities;
    expect((snap?.thread ?? []).some((row) => row.id === "chat-1")).toBe(false);
    expect((snap?.turn ?? []).some((row) => row.threadId === "chat-1")).toBe(false);
    expect((snap?.item ?? []).some((row) => row.threadId === "chat-1")).toBe(false);
  });
});
