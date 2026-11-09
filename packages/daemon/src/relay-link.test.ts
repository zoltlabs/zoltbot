import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "@zoltbot/core";
import { createIdentity, parsePairingUrl } from "@zoltbot/link";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Daemon, startDaemon } from "./index.js";
import type { PrivateVault } from "./private-context.js";
import { relayLink } from "./relay-link.js";
import { type FakeRelay, fakePhone, startFakeRelay } from "./relay-test-fixture.js";

const roots: string[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function memoryVault(): PrivateVault & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
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
async function desktop(d: Daemon) {
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
  const call = (method: string, params: unknown = {}, commandId?: string) => {
    const id = ++next;
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(commandId ? { commandId } : {}) }),
    );
    return new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  await call("hello", { protocolVersion: 1, token: d.token });
  return call;
}
type MemoryVault = ReturnType<typeof memoryVault>;
async function setup(options: { vault?: MemoryVault; dataDir?: string; relay?: FakeRelay } = {}) {
  mkdirSync(".cache/tests", { recursive: true });
  const dataDir = options.dataDir ?? mkdtempSync(path.resolve(".cache/tests/relay-"));
  if (!options.dataDir) roots.push(dataDir);
  const relay = options.relay ?? (await startFakeRelay());
  if (!options.relay) cleanups.push(() => relay.close());
  const vault = options.vault ?? memoryVault();
  const daemon = await startDaemon({
    dataDir,
    secrets: vault,
    relay: { retry: { baseMs: 20, maxMs: 200 }, pushDelayMs: 20 },
  });
  cleanups.push(() => daemon.close());
  const call = await desktop(daemon);
  await call("settings.set", { key: "link.relayUrl", value: relay.url }, randomUUID());
  await waitFor(() => relay.macOnline());
  return { daemon, relay, call, vault, dataDir };
}
async function pairPhone(call: Awaited<ReturnType<typeof setup>>["call"]) {
  const started = (await call("device.pair.start")) as { url: string; expiresAt: string };
  const phone = await fakePhone(started.url);
  cleanups.push(() => phone.close());
  const pending = await waitFor(async () =>
    ((await call("device.list")) as { id: string; state: string; confirmCode?: string }[]).find(
      (device) => device.state === "pending",
    ),
  );
  return { phone, pending, started };
}

describe("relay link", () => {
  it("pairs a phone after the person allows it and serves sealed JSON-RPC", async () => {
    const { daemon, relay, call } = await setup();
    const { phone, pending, started } = await pairPhone(call);
    expect(pending).toMatchObject({ id: phone.id, name: "Test iPhone", platform: "ios" });
    expect(pending.confirmCode).toBe(phone.confirmCode);
    expect(Date.parse(started.expiresAt) - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    expect(relay.fromMac).toContainEqual(expect.objectContaining({ t: "offer" }));
    await expect(phone.call("snapshot.get")).rejects.toThrow(/device_not_allowed/);
    expect(relay.allowed(phone.id)).toBe(false);

    const paired = await call(
      "device.pair.confirm",
      { id: phone.id, allow: true, confirmed: true },
      randomUUID(),
    );
    expect(paired).toMatchObject({ state: "paired" });
    expect(paired).not.toHaveProperty("confirmCode");
    expect(relay.allowed(phone.id)).toBe(true);
    // The phone waits on the Mac and hears the answer without subscribing.
    expect(
      await waitFor(() =>
        phone.events.find((row) => (row as { type?: string }).type === "device.updated"),
      ),
    ).toMatchObject({ payload: { id: phone.id, state: "paired" } });
    phone.events.length = 0;

    await phone.call("hello", { protocolVersion: 1, token: "" });
    const snapshot = (await phone.call("snapshot.get")) as {
      entities: Record<string, { id?: string; key?: string; value?: unknown }[]>;
    };
    expect(snapshot.entities.device?.[0]).toMatchObject({ id: phone.id, state: "paired" });
    const reference = snapshot.entities.settings?.find((row) => row.key === "link.identityRef");
    expect(String(reference?.value)).toMatch(/^keychain:zoltbot:/);

    // Events reach the phone sealed, and its commands carry its device id.
    await phone.call("events.subscribe", { fromSeq: daemon.store.lastSeq() });
    await phone.call("settings.set", { key: "ui.sample", value: 1 }, "phone-1");
    const event = await waitFor(() =>
      phone.events.find((row) => (row as { aggregateId?: string }).aggregateId === "ui.sample"),
    );
    expect(event).toMatchObject({ commandId: `device:${phone.id}:phone-1` });

    await expect(phone.call("device.pair.start")).rejects.toThrow(/mac_only/);
    await expect(phone.call("diagnostics.export")).rejects.toThrow(/mac_only/);
    await expect(
      phone.call(
        "compare.create",
        {
          value: { id: "phone-compare", title: "Rejected phone compare", ceiling: "read_only" },
          members: [
            { threadId: "phone-first", profileId: "first" },
            { threadId: "phone-second", profileId: "second" },
          ],
          input: [{ type: "text", text: "Compare" }],
        },
        "phone-compare-create",
      ),
    ).rejects.toThrow(/mac_only/);
    expect(daemon.store.snapshot().compare ?? []).toHaveLength(0);
    expect(await phone.call("device.list")).toHaveLength(1);
  });

  it("keeps the Mac key in the Keychain only and reuses it after a restart", async () => {
    const first = await setup();
    const { url } = (await first.call("device.pair.start")) as { url: string };
    const macId = parsePairingUrl(url).macId;
    const [stored] = [...first.vault.values.values()] as { seed: string }[];
    await first.daemon.close();
    const database = readFileSync(path.join(first.dataDir, "zoltbot.db"));
    expect(database.includes(Buffer.from(stored?.seed ?? "missing"))).toBe(false);
    expect(readFileSync(path.join(first.dataDir, "daemon.log"), "utf8")).not.toContain(
      stored?.seed ?? "missing",
    );

    const second = await setup({ vault: first.vault, dataDir: first.dataDir, relay: first.relay });
    const again = (await second.call("device.pair.start")) as { url: string };
    expect(parsePairingUrl(again.url).macId).toBe(macId);
    expect(first.vault.values.size).toBe(1);
  });

  it("drops a denied phone and cuts off a revoked one at once", async () => {
    const { relay, call } = await setup();
    const denied = await pairPhone(call);
    const dropped = await call(
      "device.pair.confirm",
      { id: denied.phone.id, allow: false, confirmed: true },
      randomUUID(),
    );
    expect(dropped).toMatchObject({ state: "revoked", archived: true, publicKey: "" });
    expect(await call("device.list")).toEqual([]);

    const { phone } = await pairPhone(call);
    await expect(
      call("device.pair.confirm", { id: phone.id, allow: true, confirmed: false }, randomUUID()),
    ).rejects.toThrow(/confirmation_required/);
    await call("device.pair.confirm", { id: phone.id, allow: true, confirmed: true }, randomUUID());
    expect(await phone.call("device.list")).toHaveLength(1);
    await call("device.revoke", { id: phone.id, confirmed: true }, randomUUID());
    await waitFor(() => !phone.open, 1000);
    expect(relay.allowed(phone.id)).toBe(false);
    expect(await call("device.list")).toEqual([]);
    await expect(phone.reconnect()).rejects.toThrow();
  });

  it("reconnects after the relay drops and the phone opens a fresh session", async () => {
    const { relay, call } = await setup();
    const { phone } = await pairPhone(call);
    await call("device.pair.confirm", { id: phone.id, allow: true, confirmed: true }, randomUUID());
    const signIns = relay.macSignIns();
    relay.dropMacs();
    await waitFor(() => relay.macSignIns() > signIns && relay.macOnline());
    phone.close();
    await waitFor(() => !phone.open);
    await phone.reconnect();
    const snapshot = (await phone.call("snapshot.get")) as { seq: number };
    expect(snapshot.seq).toBeGreaterThan(0);
    const seen = await waitFor(
      async () => ((await call("device.list")) as { lastSeenAt?: string }[])[0]?.lastSeenAt,
    );
    expect(Date.parse(seen)).toBeGreaterThan(0);
  });

  it("pushes counts only when something needs the person", async () => {
    const { daemon, relay, call } = await setup();
    const { phone } = await pairPhone(call);
    await call("device.pair.confirm", { id: phone.id, allow: true, confirmed: true }, randomUUID());
    const at = new Date().toISOString();
    for (const id of ["a", "b"])
      daemon.dispatch(
        {
          type: "create",
          kind: "interaction",
          value: {
            id,
            agentId: "p",
            threadId: "h",
            type: "question",
            version: 1,
            state: "pending",
            urgency: "blocking",
            items: [{ id: "q", prompt: "Private question text" }],
            chain: [],
            createdAt: at,
          },
        } as Command,
        `push:${id}`,
      );
    const push = await waitFor(() => relay.fromMac.find((frame) => frame.t === "push"));
    expect(push).toEqual({ t: "push", deviceId: phone.id, kind: "needs_you", count: 2 });
    await delay(100);
    expect(relay.fromMac.filter((frame) => frame.t === "push")).toHaveLength(1);
  });

  it("sends a notice push only to a relay that announced it, forgetting that on reconnect", async () => {
    const connect = async (relay: FakeRelay) => {
      const link = relayLink({
        identity: async () => createIdentity(),
        answer: async () => undefined,
        allowed: () => false,
        serve: async () => undefined,
        attach() {},
        detach() {},
        ready() {},
        presence() {},
        log() {},
        retry: { baseMs: 10, maxMs: 10 },
      });
      cleanups.push(() => link.close());
      link.configure(relay.url);
      expect(await link.online(2000)).toBe(true);
      return link;
    };
    // The relay deployed today knows nothing of notices and would count the frame against us.
    const old = await startFakeRelay();
    cleanups.push(() => old.close());
    const before = await connect(old);
    await delay(50);
    expect([before.delivers("needs_you"), before.delivers("zolt")]).toEqual([true, false]);

    const relay = await startFakeRelay({ features: ["needs_you", "task_done", "zolt"] });
    cleanups.push(() => relay.close());
    const link = await connect(relay);
    await waitFor(() => link.delivers("zolt"));
    link.configure(old.url);
    expect(await link.online(2000)).toBe(true);
    expect(link.delivers("zolt")).toBe(false);
  });

  it("makes a single simple approval push actionable with ids only", async () => {
    const { daemon, relay, call } = await setup();
    const { phone } = await pairPhone(call);
    await call("device.pair.confirm", { id: phone.id, allow: true, confirmed: true }, randomUUID());
    daemon.dispatch(
      {
        type: "create",
        kind: "interaction",
        value: {
          id: "approval-1",
          agentId: "p",
          threadId: "h",
          type: "approval",
          version: 1,
          state: "pending",
          urgency: "blocking",
          items: [
            {
              id: "a",
              prompt: "Private command text",
              choices: [{ id: "allow_once" }, { id: "reject_once" }],
            },
          ],
          chain: [],
          createdAt: new Date().toISOString(),
        },
      } as Command,
      "push:approval",
    );
    const push = await waitFor(() => relay.fromMac.find((frame) => frame.t === "push"));
    expect(push).toEqual({
      t: "push",
      deviceId: phone.id,
      kind: "needs_you",
      count: 1,
      category: "approval",
      interactionId: "approval-1",
      threadId: "h",
      version: 1,
    });
    expect(JSON.stringify(push)).not.toContain("Private command text");
  });

  it("uses the build's relay only while a phone needs it", async () => {
    mkdirSync(".cache/tests", { recursive: true });
    const dataDir = mkdtempSync(path.resolve(".cache/tests/relay-default-"));
    roots.push(dataDir);
    const relay = await startFakeRelay();
    cleanups.push(() => relay.close());
    const daemon = await startDaemon({
      dataDir,
      secrets: memoryVault(),
      relay: { retry: { baseMs: 20, maxMs: 200 }, pushDelayMs: 20, defaultUrl: relay.url },
    });
    cleanups.push(() => daemon.close());
    const call = await desktop(daemon);
    expect(await call("device.relay")).toEqual({ defaultUrl: relay.url });
    // An idle install holds no socket to the shared relay.
    await delay(150);
    expect(relay.macOnline()).toBe(false);

    const { phone } = await pairPhone(call);
    expect(relay.macOnline()).toBe(true);
    await call("device.pair.confirm", { id: phone.id, allow: true, confirmed: true }, randomUUID());
    await phone.call("hello", { protocolVersion: 1, token: "" });
    expect(await phone.call("device.list")).toHaveLength(1);

    await call("device.revoke", { id: phone.id, confirmed: true }, randomUUID());
    await waitFor(() => !relay.macOnline());
  });

  it("refuses a relay address without TLS outside this computer", async () => {
    const { call } = await setup();
    await expect(
      call(
        "settings.set",
        { key: "link.relayUrl", value: "ws://relay.example.test" },
        randomUUID(),
      ),
    ).rejects.toThrow(/invalid_relay_url/);
    await expect(
      call("settings.set", { key: "link.identityRef", value: "x" }, randomUUID()),
    ).rejects.toThrow(/setting_reserved/);
  });
});
