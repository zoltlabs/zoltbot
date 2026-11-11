import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DetectionService } from "@zoltbot/detect";
import type { DomainEvent } from "@zoltbot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Daemon, Redactor, startDaemon } from "./index.js";
import { KeychainSecrets } from "./secrets.js";

const roots: string[] = [];
const daemons: Daemon[] = [];
const sockets: WebSocket[] = [];
function directory() {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/daemon-"));
  roots.push(dir);
  return dir;
}
async function start(dataDir = directory()) {
  const d = await startDaemon({ dataDir });
  daemons.push(d);
  return d;
}
async function connect(d: Daemon, token = d.token) {
  const ws = new WebSocket(d.url, { origin: "zoltbot://desktop" });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const client = new Client(ws);
  await client.call("hello", { protocolVersion: 1, token });
  return client;
}
class Client {
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  readonly events: unknown[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === "event") {
        this.events.push(msg.params);
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }
  call(method: string, params: unknown, commandId?: string): Promise<unknown> {
    const id = ++this.next;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(commandId ? { commandId } : {}) }),
    );
    return promise;
  }
}
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const d of daemons.splice(0)) await d.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("authenticated daemon API", () => {
  it("rejects a second daemon before changing active discovery or projected state", async () => {
    const d = await start();
    d.dispatch(
      { type: "create", kind: "settings", value: { key: "owner-test", value: true } },
      "owner-setting",
    );
    const before = d.store.snapshot(),
      seq = d.store.lastSeq();
    const discoveryHash = () =>
      createHash("sha256")
        .update(readFileSync(path.join(d.dataDir, "daemon.json")))
        .digest("hex");
    const connection = discoveryHash();
    await expect(
      startDaemon({ dataDir: d.dataDir }).then((other) => {
        daemons.push(other);
        return "unexpected_duplicate_started";
      }),
    ).rejects.toThrow("daemon_already_running");
    expect(d.store.snapshot()).toEqual(before);
    expect(d.store.lastSeq()).toBe(seq);
    expect(discoveryHash()).toBe(connection);
    await d.close();
    const replacement = await start(d.dataDir);
    expect(replacement.store.snapshot()).toEqual(before);
  });
  it("releases startup resources and ownership after a setup factory fails", async () => {
    const dataDir = directory();
    await expect(
      startDaemon({
        dataDir,
        setup: () => {
          throw new Error("synthetic_startup_failure");
        },
      }),
    ).rejects.toThrow("synthetic_startup_failure");
    expect(existsSync(path.join(dataDir, "daemon.json"))).toBe(false);
    const replacement = await start(dataDir);
    expect(replacement.store.snapshot()).toEqual({
      view: [expect.objectContaining({ id: "command-map", granted: [] })],
    });
  });
  it("routes usage reads and confirmed budget changes through authenticated sockets", async () => {
    const d = await start();
    const client = await connect(d);
    expect(await client.call("usage.query", {})).toEqual([]);
    expect(await client.call("overhead.get", { sessionId: "empty" })).toEqual({
      injectedTokens: 0,
    });
    const budget = { scopeType: "day", scopeId: "2026-10-28", usd: 1, confirmed: true };
    await expect(
      client.call("budget.set", { ...budget, confirmed: false }, "unconfirmed-budget"),
    ).rejects.toThrow("human_budget_confirmation_required");
    expect(await client.call("budget.set", budget, "socket-budget")).toEqual({ ok: true });
    expect(d.store.snapshot().audit?.[0]).toMatchObject({
      action: "budget.set",
      actor: { kind: "human", id: "local-owner" },
    });
  });
  it("routes confirmed rule creation and revocation through authenticated sockets", async () => {
    const d = await start();
    const client = await connect(d);
    const rule = {
      scope: "global",
      matcher: { tool: "execute", command: { prefix: ["git", "status"] } },
      decision: "allow",
    };
    await expect(
      client.call("rule.create", { rule, confirmed: false }, "unconfirmed-rule"),
    ).rejects.toThrow("confirmation_required");
    const created = (await client.call(
      "rule.create",
      { rule, confirmed: true },
      "socket-rule",
    )) as { id: string };
    expect(await client.call("rule.list", {})).toMatchObject({ items: [{ id: created.id }] });
    expect(await client.call("rule.revoke", { id: created.id }, "socket-revoke")).toEqual({
      ok: true,
    });
    expect(d.store.snapshot().rule?.[0]?.revokedAt).toBeDefined();
    expect(d.store.snapshot().audit).toHaveLength(2);
  });
  it("lets exactly one socket client answer and sends the provider one reply", async () => {
    const replies: unknown[] = [];
    const d = await startDaemon({
      dataDir: directory(),
      interactionHost: {
        registerSecret() {},
        requiresSecretReply: () => true,
        respond: async (_request, answer) => {
          replies.push(answer);
        },
      },
    });
    daemons.push(d);
    const at = "2026-10-27T12:00:00.000Z";
    const definition = {
      id: "fake",
      displayName: "Fake",
      adapter: "acp",
      binaryNames: [],
      versionCommand: [],
      launch: { command: "fake", args: [], env: {} },
      testedVersions: "1.0.0",
      defaults: { permissionProfile: "read_only" },
      staticCapabilities: {},
      nativeSessionRoots: [],
      experimental: false,
    };
    const profile = {
      id: "profile",
      name: "Builder",
      avatar: "B",
      definitionId: "fake",
      kind: "profile",
      permissionProfile: "read_only",
      instructions: "",
      hidden: false,
      archived: false,
    };
    const thread = {
      id: "thread",
      agentId: "profile",
      kind: "main",
      title: "Test",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    };
    for (const [kind, value] of [
      ["agentDefinition", definition],
      ["agent", profile],
      ["thread", thread],
    ] as const)
      d.dispatch({ type: "create", kind, value }, `seed:${kind}`);
    if (!d.interactions) throw new Error("missing_interaction_runtime");
    d.interactions.request(
      {
        id: "question",
        agentId: "profile",
        threadId: "thread",
        type: "question",
        items: [{ id: "q", prompt: "Choose" }],
        chain: [],
        urgency: "blocking",
      },
      "request",
    );
    const desktop = await connect(d),
      phone = await connect(d);
    await desktop.call("events.subscribe", { fromSeq: d.store.lastSeq() });
    await phone.call("events.subscribe", { fromSeq: d.store.lastSeq() });
    const params = {
      id: "question",
      version: 1,
      answer: {
        action: "accept",
        answers: { q: { other: "Selected" } },
        by: { kind: "human", id: "owner" },
        at,
      },
    };
    const results = await Promise.allSettled([
      desktop.call("interaction.answer", params, "desktop-answer"),
      phone.call("interaction.answer", params, "phone-answer"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(replies).toHaveLength(1);
    for (const client of [desktop, phone])
      expect(client.events).toContainEqual(
        expect.objectContaining({ type: "interaction.resolved" }),
      );
    const winner = results[0]?.status === "fulfilled" ? "desktop-answer" : "phone-answer";
    expect(await desktop.call("interaction.answer", params, winner)).toMatchObject({
      state: "answered",
      resolution: { by: { kind: "human", id: "local-owner" } },
    });
    expect(replies).toHaveLength(1);
    expect(await desktop.call("interaction.list", {})).toMatchObject({
      items: [{ id: "question", state: "answered", version: 2 }],
    });
  });
  it("serves native metadata and resume commands without launching a provider", async () => {
    const d = await start();
    const session = {
      provider: "codex",
      nativeId: "native-one",
      adopted: false,
      missing: false,
      lastSeenAt: "2026-10-27T12:00:00.000Z",
    };
    d.dispatch({ type: "create", kind: "nativeSession", value: session }, "native-seed");
    const client = await connect(d);
    expect(await client.call("native.list", {})).toEqual({ items: [session] });
    expect(
      await client.call("native.openCommand", { provider: "codex", nativeId: "native-one" }),
    ).toEqual({ command: "'codex' 'resume' 'native-one'" });
    await expect(
      client.call("native.openCommand", { provider: "codex", nativeId: "absent" }),
    ).rejects.toThrow("native_session_not_found");
  });
  it("publishes a private connection file and accepts an authenticated snapshot", async () => {
    const d = await start();
    const client = await connect(d);
    expect(statSync(path.join(d.dataDir, "daemon.json")).mode & 0o777).toBe(0o600);
    expect(await client.call("snapshot.get", {})).toMatchObject({
      seq: 1,
      entities: { view: [expect.objectContaining({ id: "command-map", granted: [] })] },
    });
    expect(d.interactions).toBeUndefined();
    expect(await client.call("interaction.list", {})).toEqual({ items: [] });
    expect(d.interactions).toBeUndefined();
  });
  it("rejects invalid tokens and disallowed origins", async () => {
    const d = await start();
    await expect(connect(d, "wrong-token")).rejects.toThrow(/unauthorized/);
    const ws = new WebSocket(d.url, { origin: "https://untrusted.invalid" });
    sockets.push(ws);
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    ).rejects.toThrow();
  });
  it("streams committed events, replays missed events, and resyncs an impossible sequence", async () => {
    const d = await start();
    const baseline = d.store.lastSeq();
    const first = await connect(d);
    await first.call("events.subscribe", { fromSeq: baseline });
    await first.call("settings.set", { key: "theme", value: "dark" }, "theme-1");
    await delay(10);
    expect(first.events).toHaveLength(1);
    const second = await connect(d);
    expect(await second.call("events.subscribe", { fromSeq: baseline })).toMatchObject({
      resync: false,
      events: [{ type: "settings.created" }],
    });
    expect(await second.call("events.subscribe", { fromSeq: 9999 })).toMatchObject({
      resync: true,
      seq: baseline + 1,
    });
    await first.call("settings.set", { key: "theme", value: "dark" }, "theme-1");
    expect(d.store.lastSeq()).toBe(baseline + 1);
  });
  it("rejects malformed payloads and never persists registered secrets", async () => {
    const redactor = new Redactor(["seeded-secret"]);
    const dataDir = directory();
    const d = await startDaemon({ dataDir, redactor });
    daemons.push(d);
    const c = await connect(d);
    await expect(
      c.call("settings.set", { key: "theme", value: "dark", bypass: true }, "bad"),
    ).rejects.toThrow(/Invalid payload/);
    await c.call(
      "settings.set",
      { key: "private", value: { token: "seeded-secret", note: "value seeded-secret" } },
      "redacted",
    );
    expect(JSON.stringify(d.store.snapshot())).not.toContain("seeded-secret");
    const diagnostics = await c.call("diagnostics.export", {});
    expect(JSON.stringify(diagnostics)).not.toContain("seeded-secret");
    expect(readFileSync(path.join(dataDir, "daemon.log"), "utf8")).not.toContain("seeded-secret");
  });
});

it("expires pending requests and interrupts running turns before accepting work after restart", async () => {
  const d = await start();
  const dataDir = d.dataDir;
  const at = "2026-10-27T12:00:00.000Z";
  const records: [string, Record<string, unknown>][] = [
    [
      "agentDefinition",
      {
        id: "local",
        displayName: "Local",
        adapter: "local",
        binaryNames: ["node"],
        versionCommand: ["--version"],
        launch: { command: "node", args: [], env: {} },
        testedVersions: "*",
        defaults: { permissionProfile: "workspace_write" },
        staticCapabilities: {},
        nativeSessionRoots: [],
        experimental: false,
      },
    ],
    [
      "agent",
      {
        id: "p",
        name: "Builder",
        avatar: "B",
        definitionId: "local",
        kind: "profile",
        permissionProfile: "workspace_write",
        instructions: "",
        hidden: false,
        archived: false,
      },
    ],
    [
      "thread",
      {
        id: "h",
        agentId: "p",
        kind: "main",
        title: "Recovery",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    ],
    [
      "session",
      {
        id: "s",
        threadId: "h",
        provider: "local",
        cwd: dataDir,
        state: "running",
        capabilities: {},
        startedAt: at,
      },
    ],
    [
      "turn",
      { id: "t", threadId: "h", sessionId: "s", status: "running", origin: "human", startedAt: at },
    ],
    [
      "interaction",
      {
        id: "i",
        agentId: "p",
        threadId: "h",
        turnId: "t",
        type: "approval",
        version: 1,
        state: "pending",
        urgency: "blocking",
        items: [{ id: "q", prompt: "Allow?" }],
        chain: [],
        createdAt: at,
      },
    ],
  ];
  const events: DomainEvent[] = records.map(([kind, value], i) => ({
    eventId: `seed-${i}`,
    aggregateType: kind,
    aggregateId: String(value.id),
    type: `${kind}.created`,
    occurredAt: at,
    payload: value,
  }));
  d.store.dispatch("seed", () => ({ events, result: null }));
  await d.close();
  const restarted = await start(dataDir);
  const state = restarted.store.snapshot();
  expect(state.turn?.[0]).toMatchObject({ status: "interrupted", stopReason: "daemon_restart" });
  expect(state.interaction?.[0]).toMatchObject({ state: "expired", version: 2 });
  expect(state.item?.some((i) => i.kind === "note")).toBe(true);
  const c = await connect(restarted);
  expect(await c.call("snapshot.get", {})).toMatchObject({ counters: { pendingInteractions: 0 } });
});

it("serves setup methods over authenticated RPC with import consent and exact selection", async () => {
  const root = directory();
  const home = path.join(root, "synthetic-home");
  mkdirSync(home);
  const daemon = await startDaemon({
    dataDir: root,
    setup: (context) =>
      new DetectionService({
        dataDir: root,
        home,
        builtins: [],
        paths: [],
        knownPaths: [],
        onApply: context.applyImport,
      }),
  });
  daemons.push(daemon);
  const client = await connect(daemon);
  expect(await client.call("agentDefinition.list", {})).toEqual({ items: [] });
  expect(await client.call("detect.scan", {})).toEqual([]);
  await expect(client.call("import.preview", { sources: [], consent: false })).rejects.toThrow(
    "import_consent_required",
  );
  const preview = (await client.call("import.preview", { sources: [], consent: true })) as {
    previewId: string;
    items: unknown[];
  };
  expect(preview.items).toEqual([]);
  const repo = path.join(root, "chosen", "repository");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const repositoryPreview = (await client.call("import.preview", {
    sources: ["git"],
    consent: true,
    codeFolders: [path.dirname(repo)],
  })) as { previewId: string; items: { id: string; path: string }[] };
  expect(repositoryPreview.items.map((item) => item.path)).toEqual([repo]);
  const selected = repositoryPreview.items.map((item) => item.id);
  await client.call("import.apply", {
    previewId: repositoryPreview.previewId,
    selected,
    consent: true,
  });
  expect(daemon.store.snapshot().project).toHaveLength(1);
  await expect(
    client.call("import.apply", {
      previewId: repositoryPreview.previewId,
      selected: [],
      consent: true,
    }),
  ).rejects.toThrow("import_selection_conflict");
  expect(
    JSON.parse(
      readFileSync(path.join(root, "imports", `${repositoryPreview.previewId}.json`), "utf8"),
    ).items,
  ).toHaveLength(1);

  await expect(
    client.call("import.apply", {
      previewId: preview.previewId,
      selected: ["invented"],
      consent: true,
    }),
  ).rejects.toThrow("unknown_import_item");
  expect(
    await client.call("import.apply", {
      previewId: preview.previewId,
      selected: [],
      consent: true,
    }),
  ).toEqual({ ok: true });
  expect(
    JSON.parse(readFileSync(path.join(root, "imports", `${preview.previewId}.json`), "utf8")),
  ).toEqual({ id: preview.previewId, items: [] });
});

it("rejects known private values in imported metadata before durable projection writes", async () => {
  const root = directory(),
    secret = "synthetic-private-import-title";
  let failReads = false;
  let apply: ((receipt: unknown) => Promise<void>) | undefined;
  const daemon = await startDaemon({
    dataDir: root,
    secrets: new KeychainSecrets(async () => {
      if (failReads) throw new Error("synthetic_private_vault_failure");
      return {
        ok: true,
        value: JSON.stringify({ version: 1, hideFrames: true, values: [secret] }),
      };
    }),
    setup: (context) => {
      apply = context.applyImport;
      return new DetectionService({
        dataDir: root,
        home: root,
        builtins: [],
        paths: [],
        knownPaths: [],
        onApply: context.applyImport,
      });
    },
  });
  daemons.push(daemon);
  daemon.dispatch(
    {
      type: "create",
      kind: "settings",
      value: {
        key: "runtime.privateRef.closed",
        value: "keychain:zoltbot:11111111-1111-4111-8111-111111111111",
      },
    },
    "protected-ref",
  );
  const before = daemon.store.lastSeq();
  await expect(
    apply?.({
      id: "private-preview",
      items: [{ id: "item", kind: "session", source: "codex", name: secret, nativeId: "native" }],
    }),
  ).rejects.toThrow("private_value_requires_secure_field");
  expect(daemon.store.lastSeq()).toBe(before);
  expect(daemon.store.receipt("import:private-preview")).toBeUndefined();
  if (!apply) throw new Error("fixture_import_callback_missing");
  const publicReceipt = {
    id: "public-preview",
    items: [
      {
        id: "public-item",
        kind: "session",
        source: "codex",
        name: "Public title",
        nativeId: "public-native",
      },
    ],
  };
  await apply(publicReceipt);
  expect(daemon.store.receipt("import:public-preview")).toBeDefined();
  failReads = true;
  daemon.dispatch(
    {
      type: "create",
      kind: "settings",
      value: {
        key: "runtime.privateRef.changed",
        value: "keychain:zoltbot:22222222-2222-4222-8222-222222222222",
      },
    },
    "changed-reference",
  );
  const beforeReplay = daemon.store.lastSeq();
  await apply(publicReceipt);
  expect(daemon.store.lastSeq()).toBe(beforeReplay);
});
