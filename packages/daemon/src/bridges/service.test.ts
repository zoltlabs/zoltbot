import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { BridgeError, FakeBridgeAdapter, type InboundMessage } from "@zoltbot/bridges";
import { type BridgeView, type DomainEvent, parseEvent } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeRows } from "./records.js";
import { startBridges } from "./service.js";

let root: string;
let store: Store;
let fake: FakeBridgeAdapter;
let sent: { method: string; params: Record<string, unknown>; commandId: string }[];
let vault: Map<string, unknown>;
let services: ReturnType<typeof startBridges>[];

function seed(kind: string, value: Record<string, unknown>) {
  store.dispatch(`seed-${kind}-${value.id}`, () => ({
    events: [
      parseEvent({
        eventId: `seed-${kind}-${value.id}:0`,
        commandId: `seed-${kind}-${value.id}`,
        aggregateType: kind,
        aggregateId: String(value.id),
        type: `${kind}.updated`,
        occurredAt: "2026-11-21T10:00:00Z",
        payload: value,
      }),
    ],
    result: {},
  }));
}

beforeEach(async () => {
  mkdirSync(".cache/tests", { recursive: true });
  root = mkdtempSync(path.resolve(".cache/tests/bridges-"));
  store = await openStore(path.join(root, "test.db"));
  fake = new FakeBridgeAdapter("Acme");
  sent = [];
  vault = new Map();
  services = [];
  seed("agentDefinition", {
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
  seed("agent", {
    id: "agent-zolt",
    definitionId: "sample",
    name: "Support desk",
    avatar: "S",
    kind: "profile",
    permissionProfile: "workspace_write",
    instructions: "",
    hidden: false,
    archived: false,
  });
  seed("thread", {
    id: "chat-1",
    agentId: "agent-zolt",
    kind: "main",
    title: "Support",
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: "2026-11-21T09:00:00Z",
    lastActivityAt: "2026-11-21T10:00:00Z",
  });
});
afterEach(async () => {
  await Promise.all(services.map((service) => service.close()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const published: DomainEvent[] = [];
function start() {
  const service = startBridges({
    store,
    publish: (events) => published.push(...events),
    secrets: {
      put: async (value) => {
        const reference = `keychain:zoltbot:00000000-0000-4000-8000-${String(vault.size).padStart(12, "0")}`;
        vault.set(reference, value);
        return { reference };
      },
      read: async (reference) => {
        if (!vault.has(reference)) throw new Error("keychain_unavailable");
        return vault.get(reference);
      },
      remove: async (reference) => {
        vault.delete(reference);
      },
    },
    remember: () => {},
    adapters: { slack: () => fake, telegram: () => fake },
    initialMs: 5,
    maxMs: 20,
    send: async (method, params, commandId) => {
      sent.push({ method, params, commandId });
      if (method === "channel.post") return { post: { id: "p" }, request: { id: "request-1" } };
      return { id: `input-${sent.length}`, disposition: "queued" };
    },
  });
  services.push(service);
  return service;
}

const route = {
  id: "route-1",
  from: { id: "C1", label: "#support" },
  to: { kind: "chat", threadId: "chat-1" },
  allow: [{ id: "U1", name: "Priya" }],
};
let saves = 0;
async function save(service: ReturnType<typeof startBridges>, routes: unknown[] = [route]) {
  return (await service.api(
    "bridge.save",
    {
      bridge: { id: "b1", kind: "slack", label: "Acme", enabled: true, routes },
      credentials: { botToken: "xoxb-secret", appToken: "xapp-secret" },
    },
    `save-${++saves}`,
  )) as BridgeView;
}
const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: "m1",
  place: { id: "C1", label: "#support", direct: false },
  sender: { id: "U1", name: "Priya" },
  text: "Is the build green?",
  reply: { channel: "C1", thread: "m1" },
  ...over,
});
/** Plays the events a turn makes: the input joins the turn, the agent answers, the turn ends. */
function turn(service: ReturnType<typeof startBridges>, inputId: string, answer: string) {
  const event = (aggregateType: string, payload: Record<string, unknown>) =>
    ({
      eventId: `${aggregateType}-${payload.id}`,
      aggregateType,
      aggregateId: String(payload.id),
      type: `${aggregateType}.updated`,
      occurredAt: new Date().toISOString(),
      payload,
    }) as DomainEvent;
  service.observe([
    event("item", { id: inputId, kind: "user", threadId: "chat-1", turnId: "turn-1", seq: 1 }),
    event("item", {
      id: "reply-0",
      kind: "message",
      threadId: "chat-1",
      turnId: "turn-1",
      seq: 2,
      body: { text: "Checking." },
    }),
    event("item", {
      id: "reply-1",
      kind: "message",
      threadId: "chat-1",
      turnId: "turn-1",
      seq: 3,
      body: { text: answer },
    }),
  ]);
  service.observe([event("turn", { id: "turn-1", threadId: "chat-1", status: "completed" })]);
}

describe("bridges", () => {
  it("keeps tokens in the keychain and shows the bridge as connected", async () => {
    const service = start();
    const view = await save(service);
    expect(view.bridge.credentialRef).toMatch(/^keychain:zoltbot:/);
    expect(JSON.stringify(store.snapshot(["settings"]))).not.toContain("xoxb-secret");
    expect(vault.get(String(view.bridge.credentialRef))).toEqual({
      botToken: "xoxb-secret",
      appToken: "xapp-secret",
    });
    await vi.waitFor(() =>
      expect(bridgeRows(store).status.get("b1")).toMatchObject({
        state: "connected",
        account: "Acme",
      }),
    );
  });

  it("turns an allowed message into a queued input and posts the answer back", async () => {
    const service = start();
    await save(service);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    fake.deliver(message());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("turn.send");
    expect(sent[0]?.params).toMatchObject({
      threadId: "chat-1",
      mode: "queue",
      input: [
        { type: "text", text: "Message from Priya on Slack in #support:\nIs the build green?" },
      ],
    });
    // The same message delivered twice queues once.
    fake.deliver(message());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
    await vi.waitFor(() => expect(bridgeRows(store).pending.get("b1")).toHaveLength(1));
    turn(service, "input-1", "Yes, all green.");
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    // Only the answer goes back, not what the agent said on the way.
    expect(fake.sent[0]).toEqual({
      target: { channel: "C1", thread: "m1" },
      message: { text: "Yes, all green.", as: { name: "Support desk" } },
    });
    expect(bridgeRows(store).pending.get("b1")).toEqual([]);
  });

  it("refuses people who aren't on the route's list and records the attempt once", async () => {
    const service = start();
    await save(service);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    fake.deliver(message({ id: "m2", sender: { id: "U9", name: "Sam" } }));
    fake.deliver(message({ id: "m3", sender: { id: "U9", name: "Sam" } }));
    await vi.waitFor(() => expect(bridgeRows(store).refused.get("b1")).toHaveLength(1));
    expect(sent).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(bridgeRows(store).refused.get("b1")?.[0]).toMatchObject({
      routeId: "route-1",
      person: { id: "U9", name: "Sam" },
      place: { id: "C1" },
    });
    // Allowing them clears the refusal.
    await save(service, [{ ...route, allow: [...route.allow, { id: "U9", name: "Sam" }] }]);
    expect(bridgeRows(store).refused.get("b1")).toEqual([]);
  });

  it("ignores places without a route", async () => {
    const service = start();
    await save(service);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    fake.deliver(message({ id: "m4", place: { id: "C2", label: "#random", direct: false } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([]);
    expect(bridgeRows(store).refused.get("b1")).toBeUndefined();
  });

  it("never answers an approval from a bridge", async () => {
    const service = start();
    await save(service);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    fake.deliver(message({ id: "m5", text: "/allow" }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent.map((call) => call.method)).toEqual(["turn.send"]);
    // The text can't start with "/", so it can't run one of the agent's commands either.
    const input = (sent[0]?.params.input as { text: string }[])[0]?.text ?? "";
    expect(input.startsWith("/")).toBe(false);
  });

  it("posts to a channel and answers with the agents' posts on that request", async () => {
    seed("project", {
      id: "p1",
      name: "Web",
      goal: "",
      instructions: "",
      constraints: "",
      roots: [],
      hierarchyDepth: 1,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: "2026-11-21T09:00:00Z",
    });
    seed("channel", {
      id: "channel-1",
      projectId: "p1",
      kind: "project",
      name: "support",
      leadThreadId: "chat-1",
      memberThreadIds: ["chat-1"],
      createdAt: "2026-11-21T09:00:00Z",
      updatedAt: "2026-11-21T09:00:00Z",
    });
    const service = start();
    await save(service, [{ ...route, to: { kind: "channel", channelId: "channel-1" } }]);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    fake.deliver(message({ id: "m6" }));
    await vi.waitFor(() => expect(bridgeRows(store).pending.get("b1")).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "channel.post", params: { channelId: "channel-1" } });
    service.observe([
      {
        eventId: "post-2",
        aggregateType: "channelPost",
        aggregateId: "post-2",
        type: "channelPost.created",
        occurredAt: new Date().toISOString(),
        payload: {
          id: "post-2",
          requestId: "request-1",
          author: { kind: "thread", threadId: "chat-1" },
          text: "On it.",
        },
      } as DomainEvent,
    ]);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]?.message).toEqual({ text: "On it.", as: { name: "Support desk" } });
  });

  it("reconnects after a dropped connection and stops on a refused token", async () => {
    const service = start();
    await save(service);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    fake.drop();
    await vi.waitFor(() => expect(fake.started).toBe(2));
    await vi.waitFor(() => expect(bridgeRows(store).status.get("b1")?.state).toBe("connected"));
    fake.failNext = new BridgeError("token_refused");
    fake.drop(new BridgeError("network"));
    await vi.waitFor(() =>
      expect(bridgeRows(store).status.get("b1")).toMatchObject({
        state: "stopped",
        problem: "token_refused",
      }),
    );
  });

  it("removes a bridge and its tokens only when confirmed", async () => {
    const service = start();
    const view = await save(service);
    await expect(service.api("bridge.remove", { id: "b1" }, "remove-0")).rejects.toThrow(
      "confirmation_required",
    );
    await service.api("bridge.remove", { id: "b1", confirmed: true }, "remove-1");
    expect(vault.has(String(view.bridge.credentialRef))).toBe(false);
    expect(await service.api("bridge.list", {}, undefined)).toEqual({ items: [] });
    await vi.waitFor(() => expect(fake.stopped).toBeGreaterThan(0));
  });

  it("says a bridge without a token isn't set up", async () => {
    const service = start();
    await service.api(
      "bridge.save",
      { bridge: { id: "b2", kind: "telegram", label: "Bot", enabled: true, routes: [] } },
      "save-2",
    );
    await vi.waitFor(() =>
      expect(bridgeRows(store).status.get("b2")).toMatchObject({
        state: "stopped",
        problem: "not_set_up",
      }),
    );
  });

  it("pairs the owner's Telegram account with the code, then forgets the code", async () => {
    const service = start();
    const direct = { id: "dm-route", from: { id: "dm", label: "" }, to: route.to, allow: [] };
    const view = (await service.api(
      "bridge.save",
      {
        bridge: { id: "t1", kind: "telegram", label: "Telegram", enabled: true, routes: [direct] },
        credentials: { token: "123:secret" },
      },
      "save-telegram",
    )) as BridgeView;
    const code = (view.bridge.options?.pairing as { code: string }).code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    const dm = (text: string, id: string): InboundMessage => ({
      id,
      place: { id: "7", label: "", direct: true },
      sender: { id: "7", name: "Sam Lee" },
      text,
      reply: { chat: 7 },
    });
    fake.deliver(dm("/start WRONG1", "1"));
    fake.deliver(dm(`/start ${code.toLowerCase()}`, "2"));
    await vi.waitFor(() =>
      expect(bridgeRows(store).bridges.get("t1")?.routes[0]?.allow).toEqual([
        { id: "7", name: "Sam Lee" },
      ]),
    );
    expect(bridgeRows(store).bridges.get("t1")?.options?.pairing).toBeUndefined();
    expect(fake.sent.at(-1)?.message.text).toMatch(/^Paired/);
    expect(sent).toHaveLength(0);
    expect(bridgeRows(store).refused.get("t1") ?? []).toHaveLength(0);
    fake.deliver(dm("hello", "3"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it("passes photos to a chat as images and names other files", async () => {
    const service = start();
    await save(service);
    await vi.waitFor(() => expect(fake.started).toBe(1));
    fake.deliver(
      message({
        text: "",
        attachments: [
          { name: "photo.jpg", mimeType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]) },
          { name: "fake.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
          { name: "notes.pdf", mimeType: "application/pdf", data: new Uint8Array([4]) },
        ],
      }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const input = sent[0]?.params.input as { type: string; text?: string; base64?: string }[];
    expect(input[0]?.text).toContain("2 files not passed on.");
    expect(input[1]).toEqual({ type: "image", mimeType: "image/jpeg", base64: "/9j/" });
    expect(input).toHaveLength(2);
  });
});
