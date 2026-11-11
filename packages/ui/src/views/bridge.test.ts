import type { HostMessage, TopicValues } from "@zoltbot/view-api";
import { expect, it, vi } from "vitest";
import { type Ready, ViewBridge } from "./bridge.js";

function fixture() {
  let now = 0;
  const messages: HostMessage[] = [];
  const ready: Ready = {
    t: "ready",
    api: 1,
    view: { id: "example", name: "Example", version: "1.0.0" },
    granted: ["read"],
    theme: {
      scheme: "dark",
      tokens: {},
      fontSans: "sans-serif",
      fontMono: "monospace",
      fontScale: 1,
    },
    locale: "en",
    reducedMotion: false,
    mock: false,
  };
  const failed = vi.fn(),
    call = vi.fn(async () => "result"),
    key = vi.fn(),
    close = vi.fn();
  const host = new ViewBridge({
    port: { postMessage: (message) => messages.push(message), close },
    now: () => now,
    ready: () => ready,
    call,
    key,
    failed,
  });
  return {
    host,
    messages,
    ready,
    call,
    key,
    failed,
    close,
    time: (value: number) => {
      now = value;
      host.tick();
    },
  };
}
const data: TopicValues = {
  chats: [],
  requests: [],
  workspaces: [],
  usage: {
    today: { costUsd: 0, costKnown: true, inputTokens: 0, outputTokens: 0 },
    activeChats: 0,
  },
  checks: [],
};
it("accepts exactly one compatible hello and ignores calls before the handshake", async () => {
  const f = fixture();
  f.host.receive({ t: "call", id: 1, method: "app.open", params: { page: "overview" } });
  f.host.receive({ t: "hello", api: 2 });
  expect(f.messages).toEqual([]);
  f.host.receive({ t: "hello", api: 1 });
  f.host.receive({ t: "hello", api: 1 });
  expect(f.messages).toEqual([f.ready]);
  expect(f.call).not.toHaveBeenCalled();
  expect(JSON.stringify(f.messages)).not.toContain('"token":');
  f.host.receive({ t: "call", id: 2, method: "app.open", params: { page: "overview" } });
  await vi.waitFor(() =>
    expect(f.messages).toContainEqual({ t: "result", id: 2, ok: true, value: "result" }),
  );
});
it("drops malformed and oversized messages and rate limits calls at 50 per second", async () => {
  const f = fixture();
  f.host.receive({ t: "hello", api: 1 });
  f.host.receive({
    t: "call",
    id: 1,
    method: "app.open",
    params: { page: "overview", extra: "x".repeat(256 * 1024) },
  });
  f.host.receive({ t: "key", combo: "arbitrary" });
  expect(f.call).not.toHaveBeenCalled();
  expect(f.key).not.toHaveBeenCalled();
  for (let id = 0; id < 51; id++)
    f.host.receive({ t: "call", id, method: "app.open", params: { page: "overview" } });
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(50));
  expect(f.messages).toContainEqual(
    expect.objectContaining({
      t: "result",
      id: 50,
      ok: false,
      error: expect.objectContaining({ code: "rate_limited" }),
    }),
  );
  f.time(1001);
  f.host.receive({ t: "call", id: 100, method: "app.open", params: { page: "overview" } });
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(51));
});
it("throttles complete topic values, pauses when hidden and refreshes on visibility", () => {
  const f = fixture();
  f.host.receive({ t: "hello", api: 1 });
  f.host.update(data);
  f.host.receive({ t: "sub", topics: ["usage"] });
  expect(f.messages.filter((message) => message.t === "data")).toHaveLength(1);
  const changed = { ...data, usage: { ...data.usage, activeChats: 1 } };
  f.host.update(changed);
  expect(f.messages.filter((message) => message.t === "data")).toHaveLength(1);
  f.time(100);
  expect(f.messages.filter((message) => message.t === "data")).toHaveLength(2);
  f.host.visibility(false);
  f.host.update(data);
  f.time(200);
  expect(f.messages.filter((message) => message.t === "data")).toHaveLength(2);
  f.host.visibility(true);
  expect(f.messages.filter((message) => message.t === "data")).toHaveLength(3);
  f.host.receive({ t: "unsub", topics: ["usage"] });
  f.host.update(changed);
  f.time(300);
  expect(f.messages.filter((message) => message.t === "data")).toHaveLength(3);
});
it("times out missing hello and missing pong; read revocation closes the port", () => {
  const missing = fixture();
  missing.time(9999);
  expect(missing.failed).not.toHaveBeenCalled();
  missing.time(10000);
  expect(missing.failed).toHaveBeenCalledOnce();
  const live = fixture();
  live.host.receive({ t: "hello", api: 1 });
  live.time(5000);
  live.host.receive({ t: "pong", id: 1 });
  live.time(19000);
  expect(live.failed).not.toHaveBeenCalled();
  live.time(20000);
  expect(live.failed).toHaveBeenCalledOnce();
  const revoked = fixture();
  revoked.host.receive({ t: "hello", api: 1 });
  revoked.ready.granted = [];
  revoked.host.tick();
  expect(revoked.close).toHaveBeenCalledOnce();
});
it("never exposes unrestricted daemon calls and checks permissions before dispatch", async () => {
  const f = fixture();
  f.host.receive({ t: "hello", api: 1 });
  for (const [id, method, params] of [
    [1, "chats.send", { chatIds: ["chat"], text: "Test" }],
    [2, "chats.interrupt", { chatIds: ["chat"] }],
    [3, "requests.answer", { requestId: "request", version: 1 }],
  ] as const) {
    f.host.receive({ t: "call", id, method, params });
    await vi.waitFor(() =>
      expect(f.messages).toContainEqual(
        expect.objectContaining({
          id,
          ok: false,
          error: expect.objectContaining({ code: "not_granted" }),
        }),
      ),
    );
  }
  f.host.receive({ t: "call", id: 4, method: "view.setGrants", params: {} });
  await vi.waitFor(() =>
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        id: 4,
        ok: false,
        error: expect.objectContaining({ code: "invalid" }),
      }),
    ),
  );
  expect(f.call).not.toHaveBeenCalled();
});
