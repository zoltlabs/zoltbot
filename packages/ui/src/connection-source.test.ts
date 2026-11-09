import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionState } from "./connection.js";
import { ConnectionSource } from "./connection-source.js";

afterEach(() => vi.useRealTimers());

const schedule = (notify: () => void) => {
  const timer = setTimeout(notify, 0);
  return () => clearTimeout(timer);
};
class Client {
  state: ConnectionState = {
    status: "connecting",
    snapshot: { seq: 0, entities: {}, counters: {} },
  };
  listeners = new Set<(state: ConnectionState) => void>();
  stopped = false;
  subscribe(listener: (state: ConnectionState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async start() {
    this.emit({ ...this.state, status: "online" });
  }
  stop() {
    this.stopped = true;
  }
  async call(method: string, params: unknown, commandId?: string) {
    return { method, params, commandId };
  }
  emit(state: ConnectionState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
it("applies exact immutable snapshots immediately and batches ordered notifications without deep comparison", async () => {
  vi.useFakeTimers();
  const client = new Client(),
    source = new ConnectionSource(() => client, schedule);
  let notifications = 0;
  const unsubscribe = source.subscribe(() => {
    notifications++;
  });
  source.connect();
  expect(source.getSnapshot()).toBe(client.state);
  const next: ConnectionState = { ...client.state, snapshot: { ...client.state.snapshot, seq: 1 } };
  vi.runAllTimers();
  const before = notifications;
  client.emit({ ...next, snapshot: { ...next.snapshot, seq: 0 } });
  client.emit(next);
  expect(notifications).toBe(before);
  vi.runAllTimers();
  expect(notifications).toBe(before + 1);
  expect(source.getSnapshot()).toBe(next);
  expect(source.getSnapshot()).toBe(source.getSnapshot());
  expect(await source.call("method", { id: "target" }, "receipt")).toEqual({
    method: "method",
    params: { id: "target" },
    commandId: "receipt",
  });
  unsubscribe();
  source.stop();
});
it("replaces owned clients after bridge changes and ignores old clients and stopped lifetimes", async () => {
  const clients: Client[] = [];
  const source = new ConnectionSource(() => {
    const client = new Client();
    clients.push(client);
    return client;
  }, schedule);
  await expect(source.call("before", {})).rejects.toThrow("Daemon unavailable");
  source.connect();
  source.stop();
  source.connect();
  expect(clients[0]?.stopped).toBe(true);
  const state = source.getSnapshot();
  clients[0]?.emit({ ...state, error: "stale client" });
  expect(source.getSnapshot()).toBe(state);
  source.connect();
  expect(clients[1]?.stopped).toBe(true);
  source.stop();
  const stopped = source.getSnapshot();
  clients[2]?.emit({ ...stopped, error: "late event" });
  expect(source.getSnapshot()).toBe(stopped);
  await expect(source.call("after", {})).rejects.toThrow("Daemon unavailable");
});

it("coalesces queued updates without a frame delay and cancels stopped notifications", async () => {
  const client = new Client(),
    source = new ConnectionSource(() => client);
  let notified = () => {};
  const notification = new Promise<void>((resolve) => {
    notified = resolve;
  });
  const listener = vi.fn(() => notified());
  source.subscribe(listener);
  source.connect();
  client.emit({ ...client.state, snapshot: { ...client.state.snapshot, seq: 1 } });
  await Promise.resolve();
  client.emit({ ...client.state, snapshot: { ...client.state.snapshot, seq: 2 } });
  expect(listener).not.toHaveBeenCalled();
  await notification;
  expect(listener).toHaveBeenCalledTimes(1);
  expect(source.getSnapshot().snapshot.seq).toBe(2);
  client.emit({ ...client.state, snapshot: { ...client.state.snapshot, seq: 3 } });
  source.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(listener).toHaveBeenCalledTimes(1);
});
