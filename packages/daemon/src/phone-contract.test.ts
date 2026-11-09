import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Value } from "@sinclair/typebox/value";
import { macOnlyMethods, methodCatalog, unservedMethods } from "@zoltbot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { type Daemon, startDaemon } from "./index.js";
import type { PrivateVault } from "./private-context.js";
import { fakePhone, startFakeRelay } from "./relay-test-fixture.js";

// What the phone may call, checked against a real zoltd (D124). Each release that opens a method
// to the phone adds it here.

const roots: string[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function memoryVault(): PrivateVault {
  const values = new Map<string, unknown>();
  return {
    async put(value) {
      const reference = `keychain:zoltbot:${randomUUID()}`;
      values.set(reference, structuredClone(value));
      return { reference };
    },
    async read(reference) {
      if (!values.has(reference)) throw new Error("keychain_unavailable");
      return structuredClone(values.get(reference));
    },
  };
}
async function waitFor<T>(check: () => T | Promise<T>, timeout = 5000): Promise<NonNullable<T>> {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error("wait_timeout");
    await delay(20);
  }
}
type Call = (method: string, params?: unknown, commandId?: string) => Promise<unknown>;
async function desktop(d: Daemon): Promise<Call> {
  const socket = new WebSocket(d.url, { origin: "zoltbot://desktop" });
  cleanups.push(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  const call: Call = (method, params = {}, commandId) => {
    const id = ++next;
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(commandId ? { commandId } : {}) }),
    );
    return new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  await call("hello", { protocolVersion: 1, token: d.token });
  return call;
}
async function setup(options: { relay?: boolean } = {}) {
  mkdirSync(".cache/tests", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".cache/tests/phone-"));
  roots.push(dataDir);
  const relay = options.relay ? await startFakeRelay() : undefined;
  if (relay) cleanups.push(() => relay.close());
  const secrets = memoryVault();
  const daemon = await startDaemon({
    dataDir,
    secrets,
    relay: { retry: { baseMs: 20, maxMs: 200 }, pushDelayMs: 20 },
  });
  cleanups.push(() => daemon.close());
  const call = await desktop(daemon);
  if (!relay) return { daemon, call, secrets };
  await call("settings.set", { key: "link.relayUrl", value: relay.url }, randomUUID());
  await waitFor(() => relay.macOnline());
  const started = (await call("device.pair.start")) as { url: string };
  const phone = await fakePhone(started.url);
  cleanups.push(() => phone.close());
  await waitFor(async () =>
    ((await call("device.list")) as { state: string }[]).some((row) => row.state === "pending"),
  );
  await call("device.pair.confirm", { id: phone.id, allow: true, confirmed: true }, randomUUID());
  await phone.call("hello", { protocolVersion: 1, token: "" });
  return { daemon, call, phone, secrets };
}

describe("phone contract", () => {
  it("lists exactly the catalogued methods zoltd does not serve", async () => {
    const { call } = await setup();
    const served: string[] = [];
    for (const method of unservedMethods) {
      expect(methodCatalog, method).toHaveProperty(method);
      expect(macOnlyMethods, method).not.toContain(method);
      const schema = methodCatalog[method].params;
      let params: unknown = {};
      try {
        params = Value.Create(schema);
      } catch {}
      if (!Value.Check(schema, params)) continue;
      const error = await call(method, params, randomUUID()).then(
        () => "",
        (failure: Error) => failure.message,
      );
      if (!error.includes("method_unavailable")) served.push(`${method}: ${error || "ok"}`);
    }
    expect(served).toEqual([]);
  });

  it("replays a phone command id instead of running it twice", async () => {
    const { phone, daemon } = await setup({ relay: true });
    if (!phone) throw new Error("no phone");
    await phone.call("settings.set", { key: "ui.sample", value: 1 }, "phone-once");
    const after = daemon.store.lastSeq();
    await phone.call("settings.set", { key: "ui.sample", value: 1 }, "phone-once");
    expect(daemon.store.lastSeq()).toBe(after);
    await expect(phone.call("diagnostics.export")).rejects.toThrow(/mac_only/);
  });

  it("lets a phone fork a chat and change its model and effort (Release 2)", async () => {
    const { phone } = await setup({ relay: true });
    if (!phone) throw new Error("no phone");
    // These reach their handlers, which refuse the unknown ids; the phone is not turned away.
    const reason = (method: string, params: unknown) =>
      phone.call(method, params, randomUUID()).then(
        () => "ok",
        (failure: Error) => failure.message,
      );
    for (const [method, params] of [
      ["thread.fork", { id: "missing" }],
      ["session.setModel", { id: "missing", model: "opus", cacheWarningAccepted: true }],
      ["session.setEffort", { id: "missing", effort: "high", cacheWarningAccepted: true }],
    ] as const)
      expect(await reason(method, params), method).not.toMatch(/mac_only|method_unavailable/);
    expect(await phone.call("model.catalog", {})).toMatchObject({ items: expect.any(Array) });
  });

  it("lets a phone manage routines and connections, and refuses a stale settings merge", async () => {
    const { phone, daemon } = await setup({ relay: true });
    if (!phone) throw new Error("no phone");
    const reason = (method: string, params: unknown) =>
      phone.call(method, params, randomUUID()).then(
        () => "ok",
        (failure: Error) => failure.message,
      );
    for (const [method, params] of [
      ["routine.pause", { id: "missing", revision: 1 }],
      ["routine.enable", { id: "missing", revision: 1 }],
      ["routine.runOnce", { id: "missing", revision: 1, occurrenceId: "run" }],
      ["routine.update", { id: "missing", expectedUpdatedAt: "2026-11-08T00:00:00.000Z" }],
      ["connection.test", { id: "missing" }],
      ["connection.disconnect", { id: "missing", confirmed: true, stopSessions: false }],
      ["message.list", {}],
      ["message.send", { message: { id: "m" } }],
      ["terminal.list", { threadId: "missing", readOnly: true }],
    ] as const)
      expect(await reason(method, params), method).not.toMatch(/mac_only|method_unavailable/);

    // Compare-and-set: the write lands only if the row still holds what the phone read.
    await phone.call("settings.set", { key: "ui.merge", value: { a: 1 }, expected: {} }, "m1");
    expect(
      await reason("settings.set", { key: "ui.merge", value: { a: 2 }, expected: {} }),
    ).toMatch(/setting_conflict/);
    await phone.call(
      "settings.set",
      { key: "ui.merge", value: { a: 2 }, expected: { value: { a: 1 } } },
      "m2",
    );
    expect(daemon.store.record("settings", "ui.merge")?.value).toEqual({ a: 2 });
  });

  it("shows a phone its connections by keychain reference, never the secret behind it", async () => {
    const { phone, daemon, secrets } = await setup({ relay: true });
    if (!phone) throw new Error("no phone");
    const secret = "SENTINEL_PHONE_ACCESS_TOKEN";
    const { reference } = await secrets.put({ accessToken: secret, refreshToken: `${secret}_R` });
    const project = (daemon.store.snapshot(["project"]).project ?? [])[0];
    new ConnectionRegistry(daemon.store.database).save(
      {
        id: "phone-connection",
        name: "service",
        version: 1,
        projectId: String(project?.id ?? "project"),
        transport: { kind: "https", url: "https://service.example/mcp" },
        credentialReference: reference,
        schemaTokens: { value: 512, source: "estimated" },
        source: "manual",
        enabled: true,
        profileIds: [],
        credentialStatus: "connected",
        health: "healthy",
      },
      0,
      true,
    );
    const seen = JSON.stringify([
      await phone.call("snapshot.get", {}),
      await phone.call("connection.list", {}),
      await phone.call("events.subscribe", { fromSeq: 0 }),
    ]);
    expect(seen).toContain("phone-connection");
    expect(seen).not.toContain(secret);
  });
});
