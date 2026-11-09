import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { type DomainEvent, type EntityKind, parseEvent } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inboxApi } from "./inbox-api.js";

let root: string, store: Store, events: DomainEvent[];
let seq = 0;
/** Writes an entity as-is, skipping the state machines: these tests only care where threads land. */
function put(kind: EntityKind, value: Record<string, unknown>) {
  const id = `seed-${++seq}`;
  store.dispatch(id, () => ({
    events: [
      parseEvent({
        eventId: `${id}:0`,
        commandId: id,
        aggregateType: kind,
        aggregateId: String(value.id ?? value.key),
        type: `${kind}.updated`,
        occurredAt: "2026-11-08T10:00:00Z",
        payload: value,
      }),
    ],
    result: {},
  }));
}
const thread = (id: string, extra: Record<string, unknown> = {}) =>
  put("thread", {
    id,
    agentId: "agent",
    kind: "main",
    title: `Thread ${id}`,
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: "2026-11-08T09:00:00Z",
    lastActivityAt: "2026-11-08T10:00:00Z",
    ...extra,
  });
const sessions = new Set<string>();
const turn = (id: string, threadId: string, status: string, endedAt?: string) => {
  if (!sessions.has(threadId)) {
    sessions.add(threadId);
    put("session", {
      id: `s-${threadId}`,
      threadId,
      provider: "claude",
      cwd: "/tmp",
      state: "ready",
      capabilities: {},
      startedAt: "2026-11-08T09:00:00Z",
    });
  }
  put("turn", {
    id,
    threadId,
    sessionId: `s-${threadId}`,
    status,
    origin: "human",
    startedAt: "2026-11-08T09:30:00Z",
    ...(endedAt ? { endedAt } : {}),
  });
};
const question = (id: string, threadId: string, state = "pending") =>
  put("interaction", {
    id,
    agentId: "agent",
    threadId,
    type: "question",
    items: [{ id: "q", prompt: "Per device or per account?" }],
    chain: [],
    urgency: "blocking",
    version: 1,
    state,
    createdAt: "2026-11-08T10:00:00Z",
  });
const message = (id: string, threadId: string, n: number, text: string) =>
  put("item", {
    id,
    threadId,
    seq: n,
    kind: "message",
    body: { text },
    createdAt: "2026-11-08T10:00:00Z",
    updatedAt: "2026-11-08T10:00:00Z",
  });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  mkdirSync(".cache/tests", { recursive: true });
  root = mkdtempSync(path.resolve(".cache/tests/inbox-"));
  store = await openStore(path.join(root, "store.db"));
  events = [];
  sessions.clear();
  put("agentDefinition", {
    id: "sample",
    displayName: "Sample",
    adapter: "acp",
    binaryNames: [],
    versionCommand: [],
    launch: { command: "fake", args: [], env: {} },
    testedVersions: "1.0.0",
    defaults: { permissionProfile: "workspace_write" },
    staticCapabilities: {},
    nativeSessionRoots: [],
    experimental: false,
  });
  put("agent", {
    id: "agent",
    definitionId: "sample",
    name: "Claude",
    avatar: "C",
    kind: "profile",
    permissionProfile: "workspace_write",
    instructions: "",
    hidden: false,
    archived: false,
  });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const calls: { method: string; params: Record<string, unknown>; commandId: string }[] = [];
function setup() {
  const inbox = inboxApi({
    store,
    publish: (rows) => {
      events.push(...rows);
      inbox.observe(rows);
    },
    answer: async (method, params, commandId) => {
      calls.push({ method, params, commandId });
      return { results: [] };
    },
    send: async (method, params, commandId) => {
      calls.push({ method, params, commandId });
      return { id: "input-1", disposition: "queued" };
    },
  });
  return inbox;
}
const row = (id: string) =>
  store.snapshot(["thread"]).thread?.find((entry) => entry.id === id) as Record<string, unknown>;

describe("inbox", () => {
  it("lists threads by mailbox with previews, counts and request chips", async () => {
    thread("t-review");
    thread("t-needs");
    thread("t-working");
    thread("t-idle", { lastReadAt: "2026-11-08T12:00:00Z" });
    turn("u1", "t-review", "completed", "2026-11-08T11:00:00Z");
    turn("u2", "t-working", "running");
    turn("u3", "t-idle", "completed", "2026-11-08T11:00:00Z");
    question("i1", "t-needs");
    question("i2", "t-needs");
    message("m1", "t-review", 1, "First draft");
    message("m2", "t-review", 2, "**Done.** The planner now lives in `packages/daemon`.");
    const { api } = setup();

    const all = (await api("thread.inbox", {})) as {
      items: {
        thread: { id: string };
        mailbox: string;
        preview: string;
        pending: object;
        unread: boolean;
      }[];
      counts: Record<string, number>;
    };
    expect(all.items.map((item) => [item.thread.id, item.mailbox])).toEqual([
      ["t-needs", "needs_you"],
      ["t-review", "review"],
      ["t-working", "working"],
    ]);
    expect(all.counts).toMatchObject({ needs_you: 1, review: 1, working: 1, later: 0, settled: 0 });
    expect(all.items[0]?.pending).toEqual({ question: 2 });
    expect(all.items[1]).toMatchObject({
      preview: "Done. The planner now lives in packages/daemon.",
      unread: true,
    });
    const review = (await api("thread.inbox", { mailbox: "review" })) as { items: unknown[] };
    expect(review.items).toHaveLength(1);
  });

  it("marks read, marks unread and only moves reads forward", async () => {
    thread("t-review");
    turn("u1", "t-review", "completed", "2026-11-08T11:00:00Z");
    const { api } = setup();
    await api("thread.markRead", { id: "t-review", at: "2026-11-08T11:05:00Z" }, "read-1");
    expect(row("t-review").lastReadAt).toBe("2026-11-08T11:05:00Z");
    await api("thread.markRead", { id: "t-review", at: "2026-11-08T10:00:00Z" }, "read-old");
    expect(row("t-review").lastReadAt).toBe("2026-11-08T11:05:00Z");
    expect(((await api("thread.inbox", {})) as { items: unknown[] }).items).toHaveLength(0);

    await api("thread.markUnread", { id: "t-review" }, "unread-1");
    expect(row("t-review").lastReadAt).toBe("2026-11-08T10:59:59.999Z");
    const after = (await api("thread.inbox", {})) as { items: { mailbox: string }[] };
    expect(after.items[0]?.mailbox).toBe("review");
  });

  it("snoozes until a time and clears the snooze", async () => {
    thread("t-review");
    turn("u1", "t-review", "completed", "2026-11-08T11:00:00Z");
    const { api } = setup();
    await api("thread.snooze", { id: "t-review", until: "2999-01-01T09:00:00Z" }, "snooze");
    expect(
      ((await api("thread.inbox", { mailbox: "later" })) as { items: unknown[] }).items,
    ).toHaveLength(1);
    await api("thread.snooze", { id: "t-review", until: null }, "wake");
    expect(row("t-review").snoozedUntil).toBeUndefined();
    expect(
      ((await api("thread.inbox", { mailbox: "review" })) as { items: unknown[] }).items,
    ).toHaveLength(1);
  });

  it("settles an idle thread at once and unarchives it", async () => {
    thread("t-review", { snoozedUntil: "2999-01-01T09:00:00Z" });
    turn("u1", "t-review", "completed", "2026-11-08T11:00:00Z");
    const { api } = setup();
    expect(await api("thread.settle", { id: "t-review" }, "settle")).toMatchObject({
      archived: true,
    });
    expect(row("t-review")).toMatchObject({ archived: true });
    expect(row("t-review").snoozedUntil).toBeUndefined();
    // A retried tap is a no-op.
    expect(await api("thread.settle", { id: "t-review" }, "settle")).toMatchObject({
      archived: true,
    });
    await api("thread.unarchive", { id: "t-review" }, "unarchive");
    expect(row("t-review").archived).toBe(false);
  });

  it("keeps a working thread in Working and archives it when the work ends", async () => {
    thread("t-working");
    turn("u1", "t-working", "running");
    const { api } = setup();
    expect(await api("thread.settle", { id: "t-working" }, "settle")).toMatchObject({
      archived: false,
    });
    expect(row("t-working")).toMatchObject({ archived: false, archiveWhenIdle: true });
    expect(
      ((await api("thread.inbox", { mailbox: "working" })) as { items: unknown[] }).items,
    ).toHaveLength(1);

    // The agent asks something on the way: the thread waits for the answer.
    question("i1", "t-working");
    turn("u1", "t-working", "completed", "2026-11-08T11:00:00Z");
    setup().observe(events.splice(0).concat(storeEvents()));
    await flush();
    expect(row("t-working").archived).toBe(false);

    question("i1", "t-working", "answered");
    setup().observe(storeEvents());
    await flush();
    expect(row("t-working")).toMatchObject({ archived: true });
    expect(row("t-working").archiveWhenIdle).toBeUndefined();
  });

  it("answers quoted questions, declines skipped ones and sends the letter as one message", async () => {
    calls.length = 0;
    thread("t-needs", { archived: true });
    question("i1", "t-needs");
    question("i2", "t-needs");
    const { api } = setup();
    const letter = "> Q1 · Per device or per account?\n\nPer account.\n\nAlso: rename the setting.";
    const result = await api(
      "thread.reply",
      {
        threadId: "t-needs",
        body: letter,
        answers: [
          { interactionId: "i1", version: 1, answers: { q: { other: "Per account." } } },
          { interactionId: "i2", version: 1 },
        ],
        mode: "steer",
      },
      "reply-1",
    );
    expect(result).toEqual({ id: "input-1", disposition: "queued", resolved: ["i1", "i2"] });
    expect(row("t-needs").archived).toBe(false);
    expect(calls.map((call) => [call.method, call.commandId])).toEqual([
      ["interaction.batchAnswer", "reply-1:answers"],
      ["turn.send", "reply-1:send"],
    ]);
    const items = calls[0]?.params.items as { id: string; answer: Record<string, unknown> }[];
    expect(items[0]?.answer).toMatchObject({
      action: "accept",
      answers: { q: { other: "Per account." } },
    });
    expect(items[1]?.answer).toMatchObject({ action: "decline" });
    expect(String(items[1]?.answer.feedback)).toContain("next message");
    expect(calls[1]?.params).toEqual({
      threadId: "t-needs",
      input: [{ type: "text", text: letter }],
      mode: "steer",
    });
  });

  it("refuses a reply quoting a stale or foreign request and changes nothing", async () => {
    calls.length = 0;
    thread("t-needs");
    thread("t-other");
    question("i1", "t-needs");
    question("i9", "t-other");
    const { api } = setup();
    await expect(
      api(
        "thread.reply",
        { threadId: "t-needs", body: "Yes", answers: [{ interactionId: "i1", version: 2 }] },
        "stale",
      ),
    ).rejects.toThrow("stale_interaction");
    await expect(
      api(
        "thread.reply",
        { threadId: "t-needs", body: "Yes", answers: [{ interactionId: "i9", version: 1 }] },
        "foreign",
      ),
    ).rejects.toThrow("not_found: interaction");
    await expect(
      api("thread.reply", { threadId: "t-needs", body: "  ", answers: [] }, "empty"),
    ).rejects.toThrow("empty_reply");
    expect(calls).toEqual([]);
  });

  it("requires a command id for writes", async () => {
    thread("t-review");
    const { api } = setup();
    await expect(api("thread.markRead", { id: "t-review" })).rejects.toThrow("command_id_required");
    expect(await api("agent.update", {})).toBeUndefined();
  });
});

function storeEvents() {
  return store.eventsSince(0).slice(-2);
}
