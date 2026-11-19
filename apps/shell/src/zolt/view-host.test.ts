// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { ViewHostEvent } from "../shared/ipc";
import type { Row, SnapshotChange } from "./daemon-client";
import { viewHandlers, viewMessages } from "./view-handlers";
import { COMMAND_MAP_ID, ViewHost } from "./view-host";

const snapshotFixture = JSON.parse(
  readFileSync(
    new URL("../../../../packages/view-api/src/fixtures/snapshot.json", import.meta.url),
    "utf8",
  ),
) as { entities: Record<string, Row[]> };

const theme = {
  scheme: "dark",
  tokens: { "--zb-text": "#fff" },
  fontSans: "",
  fontMono: "",
  fontScale: 1,
};

function mapRecord(granted: string[]): Row {
  return {
    id: COMMAND_MAP_ID,
    source: "builtin",
    name: "Command map",
    version: "2.1.0",
    api: 1,
    slots: ["page"],
    bundleHash: "a".repeat(64),
    entry: "index.html",
    requested: ["read", "act", "approve"],
    granted,
    overridesBuiltin: false,
    enabled: true,
    shortcuts: [{ id: "next-alert", keys: "Space", label: "Go to the latest alert" }],
  };
}

function setup(granted = ["read"]) {
  const entities = structuredClone(snapshotFixture.entities);
  entities.view = [mapRecord(granted)];
  const listeners = new Set<(change: SnapshotChange) => void>();
  const client = {
    snapshot: { entities },
    call: vi.fn(async (_method: string, _params: unknown, _commandId?: string) => ({})),
    onChange(listener: (change: SnapshotChange) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const change = (aggregateType: string) => {
    for (const listener of listeners)
      listener({ kind: "rows", aggregateType, rows: [], streamed: false });
  };
  let now = Date.parse("2026-01-02T12:00:00Z");
  const events: ViewHostEvent[] = [];
  const confirm = vi.fn(async () => true);
  const host = new ViewHost({
    client,
    prepare: async (hash) => ({ url: `zoltbot-view://${hash}/index.html` }),
    send: (event) => events.push(event),
    confirm,
    now: () => now,
    tickMs: 0,
  });
  host.start();
  const handlers = viewHandlers(host);
  const messages = viewMessages(host);
  const connect = async () => {
    const { sessionId } = (await handlers["view:connect"]?.({
      viewId: COMMAND_MAP_ID,
      theme,
      locale: "en-US",
      reducedMotion: false,
    })) as { sessionId: string };
    const post = (message: unknown) => messages["view:post"]?.(sessionId, message);
    post({ t: "hello", api: 1 });
    return { sessionId, post };
  };
  const sent = (sessionId: string) =>
    events.flatMap((event) =>
      event.type === "message" && event.sessionId === sessionId
        ? [event.message as Record<string, unknown>]
        : [],
    );
  const result = async (sessionId: string, id: number) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const found = sent(sessionId).find((message) => message.t === "result" && message.id === id);
      if (found) return found;
      await new Promise((done) => setTimeout(done, 0));
    }
    throw new Error(`No result for call ${id}`);
  };
  return {
    entities,
    client,
    change,
    events,
    confirm,
    host,
    handlers,
    connect,
    sent,
    result,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("finds the command map and grants the permissions the person chose", async () => {
  const f = setup([]);
  expect(await f.handlers["view:get-map"]?.(undefined)).toEqual({
    id: COMMAND_MAP_ID,
    name: "Command map",
    enabled: true,
    canRead: false,
    requested: ["read", "act", "approve"],
    granted: [],
    pending: ["read", "act", "approve"],
    shortcuts: [{ id: "next-alert", keys: "Space", label: "Go to the latest alert" }],
    error: null,
  });
  await expect(f.handlers["view:prepare"]?.(COMMAND_MAP_ID)).rejects.toThrow("can't read");
  expect(() =>
    f.handlers["view:connect"]?.({ viewId: COMMAND_MAP_ID, theme, locale: "en" }),
  ).toThrow("can't read");
  await f.handlers["view:set-grants"]?.({
    viewId: COMMAND_MAP_ID,
    permissions: ["approve", "read", "read"],
  });
  expect(f.client.call).toHaveBeenCalledWith(
    "view.setGrants",
    { id: COMMAND_MAP_ID, permissions: ["read", "approve"], confirmed: true },
    expect.any(String),
  );
  f.entities.view = [];
  expect(f.host.mapView()).toBeNull();
});

it("rejects permissions the view didn't ask for or the shell doesn't know", async () => {
  const f = setup(["read"]);
  const record = f.entities.view?.[0] as Row;
  record.requested = ["read", "approve"];
  await expect(
    f.handlers["view:set-grants"]?.({ viewId: COMMAND_MAP_ID, permissions: ["act"] }),
  ).rejects.toThrow("didn't ask");
  expect(() =>
    f.handlers["view:set-grants"]?.({ viewId: COMMAND_MAP_ID, permissions: ["owner"] }),
  ).toThrow("Invalid view permissions.");
  expect(() => f.handlers["view:set-grants"]?.(COMMAND_MAP_ID)).toThrow(
    "Invalid view permissions.",
  );
  expect(f.client.call).not.toHaveBeenCalled();

  // Revoking is a grant of fewer permissions.
  await f.handlers["view:set-grants"]?.({ viewId: COMMAND_MAP_ID, permissions: [] });
  expect(f.client.call).toHaveBeenCalledWith(
    "view.setGrants",
    { id: COMMAND_MAP_ID, permissions: [], confirmed: true },
    expect.any(String),
  );
});

it("asks again only for permissions the person hasn't reviewed, and always for read", () => {
  const f = setup(["read"]);
  const record = f.entities.view?.[0] as Row;
  record.reviewed = ["read", "act"];
  expect(f.host.mapView()).toMatchObject({ granted: ["read"], pending: ["approve"] });
  record.reviewed = ["read", "act", "approve"];
  expect(f.host.mapView()?.pending).toEqual([]);
  record.granted = [];
  expect(f.host.mapView()).toMatchObject({ canRead: false, pending: ["read"] });
});

it("forwards only the view's own shortcuts while it can read", async () => {
  const f = setup();
  const { sessionId } = await f.connect();
  f.events.length = 0;
  const messages = viewMessages(f.host);
  messages["view:shortcut"]?.(sessionId, "next-alert");
  messages["view:shortcut"]?.(sessionId, "delete-everything");
  messages["view:shortcut"]?.("other-session", "next-alert");
  expect(f.sent(sessionId)).toEqual([{ t: "event", name: "shortcut", value: "next-alert" }]);
  expect(() => messages["view:shortcut"]?.(sessionId, 4)).toThrow("shortcutId is required.");
});

it("sends ready and subscribed topic data built from the daemon snapshot", async () => {
  const f = setup();
  expect(await f.handlers["view:prepare"]?.(COMMAND_MAP_ID)).toEqual({
    url: `zoltbot-view://${"a".repeat(64)}/index.html`,
  });
  const { sessionId, post } = await f.connect();
  expect(f.sent(sessionId)[0]).toMatchObject({
    t: "ready",
    view: { id: COMMAND_MAP_ID, name: "Command map", version: "2.1.0" },
    granted: ["read"],
    theme: { scheme: "dark", tokens: { "--zb-text": "#fff" } },
    mock: false,
  });
  post({ t: "sub", topics: ["chats", "requests"] });
  const data = f.sent(sessionId).filter((message) => message.t === "data");
  expect(data.map((message) => message.topic)).toEqual(["chats", "requests"]);
  const chats = data[0]?.value as { id: string }[];
  expect(chats.map((chat) => chat.id)).toContain("needs");

  f.entities.thread = f.entities.thread?.filter((row) => row.id !== "needs");
  f.change("thread");
  f.advance(200);
  f.host.tick();
  const latest = f
    .sent(sessionId)
    .filter((message) => message.topic === "chats")
    .at(-1);
  expect((latest?.value as { id: string }[]).map((chat) => chat.id)).not.toContain("needs");

  post({ t: "sub", topics: ["secrets"] });
  post({ t: "call", id: 1 });
  post("x".repeat(300 * 1024));
  expect(f.sent(sessionId).filter((message) => message.t === "data")).toHaveLength(3);
});

it("relays calls through the grant rules before anything reaches the daemon", async () => {
  const f = setup();
  const { sessionId, post } = await f.connect();

  post({ t: "call", id: 1, method: "chats.send", params: { chatIds: ["needs"], text: "Hi" } });
  expect(await f.result(sessionId, 1)).toMatchObject({ ok: false, error: { code: "not_granted" } });
  post({ t: "call", id: 2, method: "view.setGrants", params: {} });
  expect(await f.result(sessionId, 2)).toMatchObject({ ok: false, error: { code: "invalid" } });
  post({ t: "call", id: 3, method: "app.open", params: { chatId: "missing" } });
  expect(await f.result(sessionId, 3)).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(f.client.call).not.toHaveBeenCalled();

  post({ t: "call", id: 4, method: "app.open", params: { chatId: "working" } });
  expect(await f.result(sessionId, 4)).toMatchObject({ ok: true });
  expect(f.events).toContainEqual({ type: "open", chatId: "working" });

  (f.entities.view?.[0] as Row).granted = ["read", "act"];
  f.change("view");
  expect(f.sent(sessionId).at(-1)).toMatchObject({
    t: "event",
    name: "grants",
    value: ["read", "act"],
  });
  post({ t: "call", id: 5, method: "chats.send", params: { chatIds: ["needs"], text: "Hi" } });
  expect(await f.result(sessionId, 5)).toMatchObject({ ok: true });
  expect(f.client.call).toHaveBeenCalledWith(
    "view.call",
    { id: COMMAND_MAP_ID, method: "chats.send", params: { chatIds: ["needs"], text: "Hi" } },
    expect.any(String),
  );

  post({
    t: "call",
    id: 6,
    method: "requests.answer",
    params: { requestId: "request", version: 2, choiceId: "allow_once" },
  });
  expect(await f.result(sessionId, 6)).toMatchObject({ ok: false, error: { code: "not_granted" } });
  expect(f.confirm).not.toHaveBeenCalled();
});

it("asks the person before a widening answer and stops the view when read is revoked", async () => {
  const f = setup(["read", "approve"]);
  const { sessionId, post } = await f.connect();
  f.confirm.mockResolvedValueOnce(false);
  post({
    t: "call",
    id: 1,
    method: "requests.answer",
    params: { requestId: "request", version: 2, choiceId: "allow_session" },
  });
  expect(await f.result(sessionId, 1)).toMatchObject({ ok: false, error: { code: "declined" } });
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.client.call).not.toHaveBeenCalled();

  (f.entities.view?.[0] as Row).granted = [];
  f.change("view");
  await Promise.resolve();
  expect(f.events).toContainEqual({ type: "closed", sessionId, failed: false });
  expect(f.events).toContainEqual({ type: "views-changed" });
  expect(f.host.sessionCount).toBe(0);
});

it("reports a view that never says hello as failed", async () => {
  const f = setup();
  const { sessionId } = (await f.handlers["view:connect"]?.({
    viewId: COMMAND_MAP_ID,
    theme,
    locale: "en",
    reducedMotion: false,
  })) as { sessionId: string };
  f.advance(10_001);
  f.host.tick();
  await Promise.resolve();
  expect(f.events).toContainEqual({ type: "closed", sessionId, failed: true });
});
