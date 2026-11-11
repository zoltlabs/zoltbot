import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { expect, it, vi } from "vitest";

import type { ViewMessage } from "./bridge.js";
import type { ZoltClient } from "./client.js";

type Listener = (event: Record<string, unknown>) => void;
function fixture() {
  const listeners = new Map<string, Listener>(),
    tokens = new Map<string, string>();
  const window = {
    parent: {},
    addEventListener: (name: string, callback: Listener) => listeners.set(name, callback),
  } as unknown as {
    parent: object;
    addEventListener(name: string, callback: Listener): void;
    zolt: ZoltClient;
  };
  vm.runInNewContext(readFileSync(new URL("../client/zolt.js", import.meta.url), "utf8"), {
    window,
    document: {
      documentElement: {
        style: { setProperty: (name: string, value: string) => tokens.set(name, value) },
        dataset: {},
      },
    },
    setTimeout,
    clearTimeout,
  });
  const channel = new MessageChannel(),
    messages: ViewMessage[] = [];
  channel.port1.on("message", (value: ViewMessage) => messages.push(value));
  channel.port1.start();
  return {
    window,
    listeners,
    tokens,
    messages,
    channel,
    connect() {
      listeners.get("message")?.({
        source: window.parent,
        data: { zolt: "connect", api: [1] },
        ports: [channel.port2],
      });
    },
    close() {
      listeners.get("pagehide")?.({});
      channel.port1.close();
      channel.port2.close();
    },
  };
}
it("uses only the parent's transferred port, applies theme, subscribes, and resolves calls", async () => {
  const f = fixture();
  try {
    f.listeners.get("message")?.({
      source: {},
      data: { zolt: "connect", api: [1] },
      ports: [f.channel.port2],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.messages).toEqual([]);
    f.connect();
    await vi.waitFor(() => expect(f.messages).toContainEqual({ t: "hello", api: 1 }));
    f.channel.port1.postMessage({
      t: "ready",
      api: 1,
      granted: ["read"],
      theme: { scheme: "dark", fontScale: 1, tokens: { "--zb-text": "white" } },
      mock: false,
    });
    await f.window.zolt.ready;
    expect(f.tokens.get("--zb-text")).toBe("white");
    const callback = vi.fn(),
      unsubscribe = f.window.zolt.subscribe(["chats"], callback);
    await vi.waitFor(() => expect(f.messages).toContainEqual({ t: "sub", topics: ["chats"] }));
    f.channel.port1.postMessage({ t: "data", topic: "chats", value: [] });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith("chats", []));
    unsubscribe();
    await vi.waitFor(() => expect(f.messages).toContainEqual({ t: "unsub", topics: ["chats"] }));
    const result = f.window.zolt.app.open({ chatId: "chat" });
    await vi.waitFor(() =>
      expect(
        f.messages.some((message) => message.t === "call" && message.method === "app.open"),
      ).toBe(true),
    );
    const call = f.messages.find(
      (message) => message.t === "call" && message.method === "app.open",
    );
    if (!call || call.t !== "call") throw Error("fixture call");
    f.channel.port1.postMessage({ t: "result", id: call.id, ok: true });
    await result;
    f.channel.port1.postMessage({ t: "ping", id: 3 });
    await vi.waitFor(() => expect(f.messages).toContainEqual({ t: "pong", id: 3 }));
  } finally {
    f.close();
  }
});
it("forwards fixed app keys before view handlers", async () => {
  const f = fixture();
  try {
    f.connect();
    f.channel.port1.postMessage({ t: "ready", api: 1, granted: ["read"], theme: { tokens: {} } });
    await f.window.zolt.ready;
    for (const key of ["k", "b", "i", "j", ","]) {
      const event = {
        key,
        metaKey: true,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      };
      f.listeners.get("keydown")?.(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopImmediatePropagation).toHaveBeenCalled();
    }
    await vi.waitFor(() =>
      expect(f.messages.filter((message) => message.t === "key")).toHaveLength(5),
    );
  } finally {
    f.close();
  }
});
