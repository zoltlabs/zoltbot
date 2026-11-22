import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OutcomeUnknownError, type Snapshot } from "../data/transport.js";
import type { PhoneCellConnection } from "./account.js";
import { type PhoneCloudSocket, phoneCloudConnection } from "./connection.js";

const owner = { userId: "member", sessionId: "session", orgId: "personal", deviceId: "device" };
const cached: Snapshot = { seq: 4, entities: { project: [{ id: "one" }] }, counters: {} };
const project = {
  name: "Example project",
  repository: "example/project",
  defaultBranch: "main",
  setupScript: "",
};
const offline = { status: "offline", readOnly: true };
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function credential(binding = owner, expiresIn = 600_000) {
  const readToken = vi.fn(() => randomBytes(32).toString("base64url"));
  return {
    owner: binding,
    cellUrl: "https://cell.example.invalid",
    expiresAt: new Date(Date.now() + expiresIn).toISOString(),
    readToken,
    clear: vi.fn(),
  };
}

function fakeSocket() {
  const sent: Array<{ id: number; method: string; params: unknown; commandId?: string }> = [];
  const socket: PhoneCloudSocket = {
    send(frame) {
      sent.push(JSON.parse(frame));
    },
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const receive = (frame: object) =>
    socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", ...frame }) });
  return {
    socket,
    sent,
    receive,
    reply(result: unknown) {
      receive({ id: sent.at(-1)?.id, result });
    },
  };
}

function fixture(options: Partial<Parameters<typeof phoneCloudConnection>[0]> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const handles: ReturnType<typeof credential>[] = [];
  const makeSocket = vi.fn((url: string, headers: Readonly<Record<string, string>>) => {
    expect(url).toBe("wss://cell.example.invalid/v1/orgs/personal/connect");
    expect(headers.Authorization?.startsWith("Bearer ")).toBe(true);
    const nextSocket = fakeSocket();
    sockets.push(nextSocket);
    return nextSocket.socket;
  });
  const connection = phoneCloudConnection({
    owner,
    async credentials() {
      const handle = credential();
      handles.push(handle);
      return handle;
    },
    socket: makeSocket,
    ...options,
  });
  const open = async (seq = 0, snapshot = cached) => {
    await tick();
    const active = sockets.at(-1);
    if (!active) throw new Error("fixture_socket_missing");
    active.socket.onopen?.();
    expect(active.sent.at(-1)).toMatchObject({
      method: "events.subscribe",
      params: { fromSeq: seq },
    });
    active.reply({ seq, resync: false, events: [] });
    await tick();
    expect(active.sent.at(-1)?.method).toBe("snapshot.get");
    active.reply(snapshot);
    await tick();
    return active;
  };
  return { connection, handles, makeSocket, sockets, open };
}

it("restores a read-only cache after loss, renews its subscription and never replays a command", async () => {
  const f = fixture();
  f.connection.start();
  const active = await f.open();
  expect(f.connection.state()).toEqual({ status: "online", readOnly: false, snapshot: cached });
  await expect(f.connection.call("detect.scan", {})).rejects.toThrow("method_unavailable");
  const command = expect(
    f.connection.call("cloud.project.create", project, "one-create"),
  ).rejects.toBeInstanceOf(OutcomeUnknownError);
  const read = expect(f.connection.call("snapshot.get", {})).rejects.toThrow(
    "cloud_connection_lost",
  );
  const lateMessage = active.socket.onmessage;
  active.socket.close = () => {
    throw new Error("native_close_failed");
  };
  active.socket.onerror?.();
  await Promise.all([command, read]);
  expect(f.handles[0]?.clear).toHaveBeenCalledOnce();
  expect(f.connection.state()).toEqual({
    ...offline,
    snapshot: cached,
    error: "cloud_unavailable",
  });
  await expect(f.connection.call("cloud.project.create", project, "offline")).rejects.toThrow(
    "cloud_offline",
  );
  await vi.advanceTimersByTimeAsync(500);
  const next = await f.open(4, { ...cached, seq: 5 });
  lateMessage?.({ data: '{"jsonrpc":"2.0","method":"event"}' });
  await tick();
  expect(next.sent.map((request) => request.method)).toEqual(["events.subscribe", "snapshot.get"]);
  expect(f.connection.state().snapshot.seq).toBe(5);
  f.connection.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.sockets).toHaveLength(2);
  expect(f.connection.state().snapshot.entities).toEqual({});
});

it("isolates throwing and mutating observers and folds events into a fresh projection", async () => {
  const f = fixture();
  const stopThrowing = f.connection.subscribe(() => {
    throw new Error("listener_failed");
  });
  f.connection.subscribe((state) => {
    state.snapshot.seq = 987;
  });
  const listener = vi.fn();
  const unsubscribe = f.connection.subscribe(listener);
  f.connection.start();
  const active = await f.open();
  expect(listener).toHaveBeenLastCalledWith({
    status: "online",
    readOnly: false,
    snapshot: cached,
  });
  active.receive({ method: "event" });
  active.receive({ method: "event" });
  expect(active.sent.at(-1)?.method).toBe("snapshot.get");
  active.reply({ ...cached, seq: 5 });
  await tick();
  expect(active.sent.filter(({ method }) => method === "snapshot.get")).toHaveLength(3);
  active.reply({ ...cached, seq: 6 });
  await tick();
  expect(f.connection.state().snapshot.seq).toBe(6);
  stopThrowing();
  unsubscribe();
  f.connection.stop();
});

it.each([
  "Cell close",
  "native session",
])("clears cache and prevents reconnect on %s revocation", async (path) => {
  let refuse: (() => void) | undefined;
  const unwatch = vi.fn();
  const f = fixture({
    watchAuthority(callback) {
      refuse = callback;
      return unwatch;
    },
  });
  f.connection.start();
  const active = await f.open();
  if (path === "Cell close") active.socket.onclose?.({ code: 1008 });
  else refuse?.();
  expect(f.connection.state()).toEqual({
    ...offline,
    snapshot: { seq: 0, entities: {}, counters: {} },
    error: "cloud_authority_refused",
  });
  expect(f.handles[0]?.clear).toHaveBeenCalledOnce();
  expect(unwatch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.makeSocket).toHaveBeenCalledOnce();
});

it("refuses a different credential owner on reconnect before opening another socket", async () => {
  const valid = credential(),
    invalid = credential({ ...owner, sessionId: "other-session" });
  const credentials = vi.fn().mockResolvedValueOnce(valid).mockResolvedValueOnce(invalid);
  const f = fixture({ credentials });
  f.connection.start();
  const active = await f.open();
  active.socket.onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(500);
  expect(invalid.readToken).not.toHaveBeenCalled();
  expect(invalid.clear).toHaveBeenCalledOnce();
  expect(f.makeSocket).toHaveBeenCalledOnce();
  expect(f.connection.state()).toMatchObject({
    ...offline,
    snapshot: { seq: 0 },
    error: "cloud_authority_refused",
  });
});

it("clears late credentials after stop without opening a socket or publishing stale state", async () => {
  let complete: ((value: PhoneCellConnection) => void) | undefined;
  const pending = new Promise<PhoneCellConnection>((resolve) => {
    complete = resolve;
  });
  const f = fixture({ credentials: () => pending });
  const late = credential();
  f.connection.start();
  f.connection.stop();
  complete?.(late);
  await tick();
  expect(late.clear).toHaveBeenCalledOnce();
  expect(f.makeSocket).not.toHaveBeenCalled();
  expect(f.connection.state()).toEqual({
    ...offline,
    snapshot: { seq: 0, entities: {}, counters: {} },
  });
});

it("reconnects with fresh credentials before expiry", async () => {
  const original = credential(owner, 32_000);
  const next = credential();
  const credentials = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(next);
  const f = fixture({ credentials });
  f.connection.start();
  const active = await f.open();
  await vi.advanceTimersByTimeAsync(1999);
  expect(active.socket.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(501);
  expect(original.clear).toHaveBeenCalledOnce();
  expect(active.socket.close).toHaveBeenCalledOnce();
  expect(credentials).toHaveBeenCalledTimes(2);
  expect(f.connection.state()).toMatchObject({
    status: "connecting",
    readOnly: true,
    snapshot: cached,
  });
  await f.open(4);
  f.connection.stop();
  expect(next.clear).toHaveBeenCalledOnce();
});
