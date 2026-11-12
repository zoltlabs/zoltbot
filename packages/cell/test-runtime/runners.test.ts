import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Store } from "@zoltbot/store/portable";
import { afterEach, expect, it, vi } from "vitest";
import { CellCommands } from "../src/commands.js";
import { CellRunners } from "../src/runners.js";
import { CellSandboxes } from "../src/sandboxes.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import worker from "../src/worker.js";
import { caps } from "./capabilities.js";
import { signer } from "./identity.js";

afterEach(() => vi.restoreAllMocks());
it("delivers a frozen lease and projects replayed events over the runner socket", async () => {
  const identity = await signer();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === env.CELL_JWKS_URL) return Response.json({ keys: [identity.jwk] });
    if (String(url).endsWith("/access")) return Response.json({ active: true });
    if (!String(url).endsWith("/sandboxes")) throw new Error("unexpected_network");
    const body = JSON.parse(String(init?.body));
    const at = new Date().toISOString();
    return Response.json({
      orgId: body.orgId,
      userId: body.userId,
      taskId: body.taskId,
      sandboxId: "sandbox",
      target: "e2b",
      state: "running",
      sleepKeepsProcesses: false,
      createdAt: at,
      updatedAt: at,
    });
  });
  const org = crypto.randomUUID();
  const rpc = async (method: string, params: unknown) => {
    const response = await worker.fetch(
      new Request(`https://cell.example.invalid/v1/orgs/${org}/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await identity.token(org)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
          commandId: crypto.randomUUID(),
        }),
      }),
      env,
    );
    const result = (await response.json()) as { result: Record<string, unknown>; error?: unknown };
    expect(result.error).toBeUndefined();
    return result.result;
  };
  const project = await rpc("cloud.project.create", {
    name: "Repo",
    repository: "example/repository",
    defaultBranch: "main",
    setupScript: "",
  });
  const task = await rpc("task.create", {
    title: "Task",
    brief: "Inspect the repository",
    profileId: "cloud-claude",
    node: { type: "project", id: project.id },
    location: "sandbox",
  });
  const token = await identity.token(org, {
    kind: "sandbox_runner",
    surface: "runner",
    device: "sandbox",
    task: task.id,
    session: undefined,
  });
  const response = await worker.fetch(
    new Request(`https://cell.example.invalid/v1/orgs/${org}/connect`, {
      headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
    }),
    env,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("socket_missing");
  socket.accept();
  const messages: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message: string };
  }[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "runner.hello",
      params: {
        kind: "sandbox",
        runnerId: "sandbox",
        protocolVersion: 1,
        versions: { worker: "0.1.0" },
        clis: [{ id: "claude", version: "test" }],
        sleepKeepsProcesses: false,
      },
    }),
  );
  await vi.waitFor(() =>
    expect(messages.some((message) => message.method === "runner.lease")).toBe(true),
  );
  const lease = messages.find((message) => message.method === "runner.lease")?.params;
  expect(lease?.taskId).toBe(task.id);
  expect((lease?.execution as { task: { state: string } }).task.state).toBe("running");
  expect((lease?.launchManifest as { cwd: string }).cwd).toBe(".");
  expect(messages.find((message) => message.method === "runner.ack")?.params?.runnerSeq).toBe(0);
  const send = async (seq: number, event: unknown, itemId?: string) => {
    const id = 100 + seq;
    const before = messages.filter((message) => message.id === id).length;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "runner.event",
        params: {
          taskId: task.id,
          leaseId: lease?.leaseId,
          runnerSeq: seq,
          sessionId: "session",
          event,
          ...(itemId ? { itemId } : {}),
        },
      }),
    );
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.id === id).length).toBeGreaterThan(before),
    );
    expect(messages.filter((message) => message.id === id).at(-1)?.error).toBeUndefined();
  };
  await send(1, {
    t: "session.ready",
    nativeId: "native",
    capabilities: caps,
    providerVersion: "test",
  });
  await send(2, { t: "turn.started", turnId: "turn" });
  await send(
    3,
    { t: "message.done", turnId: "turn", itemId: "provider", text: "Finished", phase: "final" },
    "message",
  );
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(org));
  await evictDurableObject(stub);
  await send(
    3,
    { t: "message.done", turnId: "turn", itemId: "provider", text: "Finished", phase: "final" },
    "message",
  );
  await send(4, { t: "turn.done", turnId: "turn", status: "completed" });
  const stored = await runInDurableObject(stub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    return {
      task: store.record("task", String(task.id)),
      items: store.read({ taskId: String(task.id) }, ["item"]).item,
    };
  });
  expect(stored.task?.state).toBe("review");
  expect(stored.items?.filter((row) => row.id === "message")).toHaveLength(1);
  const macTask = await rpc("task.create", {
    title: "Mac task",
    brief: "Inspect",
    profileId: "cloud-claude",
    node: { type: "project", id: project.id },
    location: "mac",
  });
  const macToken = await identity.token(org, {
    kind: "mac_runner",
    surface: "runner",
    device: "mac",
    grant: "grant",
  });
  const macResponse = await worker.fetch(
    new Request(`https://cell.example.invalid/v1/orgs/${org}/connect`, {
      headers: { Authorization: `Bearer ${macToken}`, Upgrade: "websocket" },
    }),
    env,
  );
  const mac = macResponse.webSocket;
  if (!mac) throw new Error("socket_missing");
  mac.accept();
  const macMessages: typeof messages = [];
  mac.addEventListener("message", (event) => {
    macMessages.push(JSON.parse(String(event.data)));
  });
  const hello = {
    kind: "mac",
    runnerId: "mac",
    protocolVersion: 1,
    versions: {},
    clis: [{ id: "claude", version: "test" }],
    sleepKeepsProcesses: false,
  };
  mac.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runner.hello", params: hello }));
  await vi.waitFor(() => expect(macMessages.some((message) => message.id === 1)).toBe(true));
  expect(macMessages.filter((message) => message.method === "runner.lease")).toHaveLength(0);
  mac.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "runner.hello",
      params: { ...hello, acceptTasks: true },
    }),
  );
  await vi.waitFor(() =>
    expect(macMessages.filter((message) => message.method === "runner.lease")).toHaveLength(1),
  );
  expect(macMessages.find((message) => message.method === "runner.lease")?.params?.taskId).toBe(
    macTask.id,
  );
  const second = await rpc("task.create", {
    title: "Second",
    brief: "Inspect",
    profileId: "cloud-claude",
    node: { type: "project", id: project.id },
    location: "mac",
  });
  await vi.waitFor(() =>
    expect(
      macMessages.some(
        (message) => message.method === "runner.lease" && message.params?.taskId === second.id,
      ),
    ).toBe(true),
  );
  mac.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "runner.drain",
      params: { runnerId: "mac", reason: "disabled" },
    }),
  );
  await vi.waitFor(() => expect(macMessages.some((message) => message.id === 3)).toBe(true));
  const held = await rpc("task.create", {
    title: "Held",
    brief: "Inspect",
    profileId: "cloud-claude",
    node: { type: "project", id: project.id },
    location: "mac",
  });
  expect(
    macMessages.some(
      (message) => message.method === "runner.lease" && message.params?.taskId === held.id,
    ),
  ).toBe(false);
  mac.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "runner.event",
      params: {
        taskId: task.id,
        leaseId: lease?.leaseId,
        runnerSeq: 5,
        sessionId: "forged",
        event: { t: "status", state: "ready" },
      },
    }),
  );
  await vi.waitFor(() =>
    expect(macMessages.find((message) => message.id === 9)?.error?.message).toBe("forbidden"),
  );
  await rpc("task.review", {
    id: task.id,
    revision: 1,
    decision: "changes",
    feedback: "Revise",
    confirmed: true,
  });
  await vi.waitFor(() =>
    expect(messages.filter((message) => message.method === "runner.lease")).toHaveLength(2),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const at = new Date().toISOString();
    const sandbox = {
      orgId: org,
      userId: "member",
      taskId: String(task.id),
      sandboxId: "sandbox",
      target: "e2b",
      state: "running",
      sleepKeepsProcesses: false,
      createdAt: at,
      updatedAt: at,
    };
    const lifecycle = new CellSandboxes(store, { request: async () => sandbox }, org, "member");
    lifecycle.checkpoint(String(task.id));
    store.database
      .prepare(
        "INSERT INTO cell_sandboxes VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body",
      )
      .run(String(task.id), JSON.stringify({ ...sandbox, state: "sleeping" }));
    await lifecycle.ensure(String(task.id));
    new CellCommands(store).enqueue(String(task.id), "interrupt-test", { type: "interrupt" });
    const runner = state
      .getWebSockets("runner")
      .find((candidate) => candidate.deserializeAttachment().runnerId === "sandbox");
    if (!runner) throw new Error("runner_missing");
    await new CellRunners(state, store).offer(runner);
    await new CellRunners(state, store).offer(runner);
  });
  await vi.waitFor(() =>
    expect(messages.filter((message) => message.method === "runner.lease")).toHaveLength(3),
  );
  const resumed = messages.filter((message) => message.method === "runner.lease").at(-1)?.params
    ?.execution as { previousNativeId?: string; queuedItems: unknown[] };
  expect(resumed.previousNativeId).toBe("native");
  expect(resumed.queuedItems).toHaveLength(2);
  await vi.waitFor(() =>
    expect(messages.some((message) => message.method === "runner.command")).toBe(true),
  );
  socket.send(
    JSON.stringify({ jsonrpc: "2.0", id: "runner-command:interrupt-test", result: { ok: true } }),
  );
  await vi.waitFor(async () =>
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        new CellCommands(new Store(new CellSqlDriver(state.storage))).pending(String(task.id)),
      ),
    ).toBe(false),
  );
  mac.close();
  socket.close();
});
