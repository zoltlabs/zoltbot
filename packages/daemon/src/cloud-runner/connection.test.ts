import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { At, parse } from "@zoltbot/protocol";
import {
  RunnerEventSchema,
  RunnerExecutionSchema,
  RunnerHeartbeatSchema,
  type RunnerLease,
  RunnerLeaseSchema,
} from "@zoltbot/runner-protocol";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  RunnerAccessRevokedError,
  RunnerConnection,
  type RunnerConnectionOptions,
} from "./connection.js";
import type { RunnerOutbox } from "./outbox.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixtureDates<T extends TSchema>(schema: T): T {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const result = { ...value } as Record<string, unknown>;
    if (result.pattern === At.pattern) result.default = "2026-11-11T00:00:00Z";
    for (const [key, item] of Object.entries(result)) result[key] = visit(item);
    return result;
  };
  return visit(schema) as T;
}
function lease(location: "mac" | "sandbox" = "mac"): RunnerLease {
  const value = Value.Create(RunnerLeaseSchema);
  const execution = Value.Create(fixtureDates(RunnerExecutionSchema));
  execution.task = {
    ...execution.task,
    id: "task",
    threadId: "thread",
    projectId: "project",
    location,
  };
  execution.thread.id = "thread";
  execution.thread.projectId = "project";
  execution.thread.agentId = execution.profile.id;
  execution.task.ownerAgentId = execution.profile.id;
  execution.task.createdBy = { kind: "human", id: "member" };
  execution.profile.definitionId = execution.definition.id;
  execution.project.id = "project";
  execution.project.cloud = {
    repository: "example/repository",
    defaultBranch: "main",
    setupScript: "",
  };
  return {
    ...value,
    taskId: "task",
    leaseId: "lease",
    actor: { userId: "member", deviceId: "runner", surface: "runner" },
    execution,
    launchManifest: {
      ...value.launchManifest,
      taskId: "task",
      threadId: "thread",
      projectId: "project",
      profileId: execution.profile.id,
      taskRevision: execution.task.revision,
    },
  };
}
const observation = {
  threadId: "thread",
  sessionId: "session",
  event: { t: "status" as const, state: "ready" as const },
};
const request = (socket: WebSocket, method: string, params: unknown, id = method) =>
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

async function fixture(
  receive: (socket: WebSocket, message: Record<string, unknown>) => void,
  overrides: Partial<RunnerConnectionOptions> = {},
  lifetimeMs = 600000,
  refuseUpgrade = false,
) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: () => !refuseUpgrade,
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_missing");
  const token = randomBytes(32).toString("base64url");
  let authenticated = true;
  server.on("connection", (socket, incoming) => {
    authenticated &&= incoming.headers.authorization === `Bearer ${token}`;
    socket.on("message", (data) => receive(socket, JSON.parse(data.toString())));
  });
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), "zoltbot-cloud-connection-"));
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  let opens = 0,
    updates = 0,
    commands = 0,
    closes = 0;
  let outbox: RunnerOutbox | undefined, publish: (() => void) | undefined;
  const statuses: string[] = [];
  let credentialsError: Error | undefined;
  const connection = new RunnerConnection({
    orgId: "org",
    hello: {
      kind: "mac",
      runnerId: "runner",
      protocolVersion: 1,
      versions: {},
      clis: [],
      sleepKeepsProcesses: true,
      acceptTasks: true,
    },
    outboxDirectory: directory,
    guard(value) {
      if (JSON.stringify(value).includes(token)) throw new Error("private_value");
    },
    credentials: async () => {
      if (credentialsError) throw credentialsError;
      return {
        url: `ws://127.0.0.1:${address.port}/v1/orgs/org/connect`,
        token,
        expiresAt: Date.now() + lifetimeMs,
      };
    },
    status: (code) => statuses.push(code),
    allowLoopback: true,
    retryBaseMs: 10,
    ...overrides,
    task: async (assignment, journal, notify, signal) => {
      opens++;
      outbox = journal;
      publish = notify;
      if (overrides.task) return overrides.task(assignment, journal, notify, signal);
      return {
        async update() {
          updates++;
        },
        async command() {
          commands++;
          return { ok: true };
        },
        async close() {
          closes++;
        },
      };
    },
  });
  cleanup.push(() => connection.close());
  connection.start();
  return {
    connection,
    server,
    statuses,
    credentialsError(error: Error | undefined) {
      credentialsError = error;
    },
    get opens() {
      return opens;
    },
    get updates() {
      return updates;
    },
    get commands() {
      return commands;
    },
    get closes() {
      return closes;
    },
    get authenticated() {
      return authenticated;
    },
    append() {
      if (!outbox || !publish) throw new Error("test_task_missing");
      const frame = outbox.append(observation);
      publish();
      return frame;
    },
  };
}
function hello(socket: WebSocket, cursor = 0, assignment = lease()) {
  request(socket, "runner.ack", { taskId: "task", runnerSeq: cursor });
  request(socket, "runner.lease", assignment);
  socket.send(
    JSON.stringify({ jsonrpc: "2.0", id: "hello", result: { ok: true, heartbeatMs: 15000 } }),
  );
}

it("withdraws private-handoff presence immediately when its native host stops or faults", async () => {
  const heartbeats: string[][] = [];
  let ready = true,
    fault = false;
  const f = await fixture(
    (socket, message) => {
      if (message.method === "runner.hello") hello(socket);
      if (message.method === "runner.heartbeat")
        heartbeats.push(parse(RunnerHeartbeatSchema, message.params).leaseIds);
    },
    {
      task: async () => ({
        ready() {
          if (fault) throw new Error("synthetic_host_fault");
          return ready;
        },
        async update() {},
        async command() {},
        async close() {},
      }),
    },
  );
  await expect.poll(() => heartbeats.at(-1)).toEqual(["lease"]);
  ready = false;
  f.append();
  await expect.poll(() => heartbeats.at(-1)).toEqual([]);
  ready = true;
  f.append();
  await expect.poll(() => heartbeats.at(-1)).toEqual(["lease"]);
  fault = true;
  f.append();
  await expect.poll(() => heartbeats.at(-1)).toEqual([]);
});

it("reconnects and replays a durable frame with the same sequence after its acknowledgement is lost", async () => {
  let hellos = 0,
    arrivals = 0,
    cursor = 0;
  const applied = new Set<number>();
  const f = await fixture((socket, message) => {
    if (message.method === "runner.hello") {
      hellos++;
      hello(socket, cursor);
    }
    if (message.method === "runner.event") {
      arrivals++;
      const frame = parse(RunnerEventSchema, message.params);
      applied.add(frame.runnerSeq);
      if (arrivals === 1) {
        socket.terminate();
        return;
      }
      cursor = frame.runnerSeq;
      request(socket, "runner.ack", { taskId: "task", runnerSeq: cursor });
    }
  });
  await expect.poll(() => f.opens).toBe(1);
  const frame = f.append();
  await expect.poll(() => cursor).toBe(1);
  expect(frame.runnerSeq).toBe(1);
  expect(hellos).toBeGreaterThanOrEqual(2);
  expect(arrivals).toBe(2);
  expect([...applied]).toEqual([1]);
  expect(f.opens).toBe(1);
  expect(f.authenticated).toBe(true);
  f.append();
  await expect.poll(() => cursor).toBe(2);
  expect([...applied]).toEqual([1, 2]);
});

it("keeps acknowledgements moving while native command handling is blocked and bounds its send window", async () => {
  let socket: WebSocket | undefined;
  const received: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const f = await fixture(
    (client, message) => {
      if (message.method === "runner.hello") {
        socket = client;
        hello(client);
      }
      if (message.method === "runner.event")
        received.push(parse(RunnerEventSchema, message.params).runnerSeq);
    },
    {
      task: async () => ({
        async update() {},
        async command() {
          entered = true;
          await barrier;
          return { ok: true };
        },
        async close() {},
      }),
    },
  );
  await expect.poll(() => f.opens).toBe(1);
  try {
    if (!socket) throw new Error("test_socket_missing");
    request(socket, "runner.command", {
      taskId: "task",
      leaseId: "lease",
      commandId: "blocked",
      command: { type: "stop" },
    });
    await expect.poll(() => entered).toBe(true);
    for (let index = 0; index < 12; index++) f.append();
    await expect.poll(() => received.length).toBe(8);
    request(socket, "runner.ack", { taskId: "task", runnerSeq: 8 });
    await expect.poll(() => received.length).toBe(12);
    request(socket, "runner.ack", { taskId: "task", runnerSeq: 12 });
    f.append();
    await expect.poll(() => received.length).toBe(13);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    release();
  }
  expect(received).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
});

it("refuses a forged Mac lease when task execution is off, while keeping the bridge available", async () => {
  let calls = 0;
  let result = false;
  const f = await fixture(
    (socket, message) => {
      if (message.method === "runner.hello") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", result: { ok: true } }));
        request(
          socket,
          "mac.exec.request",
          {
            requestId: "request",
            taskId: "task",
            turnId: "turn",
            userId: "member",
            targetDeviceId: "runner",
            command: "uname",
          },
          "bridge",
        );
      }
      if (message.id === "bridge") {
        result = Boolean(
          message.result &&
            typeof message.result === "object" &&
            "ok" in message.result &&
            message.result.ok === true,
        );
        hello(socket);
      }
    },
    {
      hello: {
        kind: "mac",
        runnerId: "runner",
        protocolVersion: 1,
        versions: {},
        clis: [],
        sleepKeepsProcesses: true,
      },
      macExec: async () => {
        calls++;
        return { ok: true };
      },
    },
  );
  await expect.poll(() => result).toBe(true);
  await expect.poll(() => f.statuses.includes("runner_lease_refused")).toBe(true);
  await f.connection.close();
  expect(f.opens).toBe(0);
  expect(calls).toBeGreaterThan(0);
});

it("refuses a missing initial cursor and a sandbox lease for another task", async () => {
  for (const missingCursor of [true, false]) {
    const f = await fixture(
      (socket, message) => {
        if (message.method !== "runner.hello") return;
        if (missingCursor) request(socket, "runner.lease", lease());
        else hello(socket, 0, lease("sandbox"));
      },
      missingCursor
        ? {}
        : {
            taskId: "other-task",
            hello: {
              kind: "sandbox",
              runnerId: "runner",
              protocolVersion: 1,
              versions: {},
              clis: [],
              sleepKeepsProcesses: false,
            },
          },
    );
    await expect.poll(() => f.statuses.includes("runner_lease_refused")).toBe(true);
    await f.connection.close();
    expect(f.opens).toBe(0);
  }
});

it("cancels pending credentials and never dials an insecure non-loopback URL", async () => {
  let requested = false,
    aborted = false;
  const f = await fixture(() => {}, {
    credentials: async (signal) => {
      requested = true;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
  });
  await expect.poll(() => requested).toBe(true);
  await f.connection.close();
  expect(aborted).toBe(true);
  const invalid = await fixture(() => {}, {
    credentials: async () => ({
      url: "ws://example.invalid/v1/orgs/org/connect",
      token: "synthetic",
      expiresAt: Date.now() + 600000,
    }),
  });
  await expect.poll(() => invalid.statuses.includes("runner_connection_unavailable")).toBe(true);
  await invalid.connection.close();
  expect(invalid.server.clients.size).toBe(0);
});

it("renews expiring credentials without opening another native task", async () => {
  let hellos = 0;
  const f = await fixture(
    (socket, message) => {
      if (message.method === "runner.hello") {
        hellos++;
        hello(socket);
      }
    },
    {},
    1500,
  );
  await expect.poll(() => hellos, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => f.updates).toBeGreaterThan(0);
  expect(f.opens).toBe(1);
  await f.connection.close();
  expect(f.closes).toBe(1);
});

it("refuses mismatched execution metadata before opening a native runtime", async () => {
  const assignment = lease();
  if (!assignment.execution) throw new Error("test_execution_missing");
  assignment.execution.thread.projectId = "local-project";
  const f = await fixture((socket, message) => {
    if (message.method === "runner.hello") hello(socket, 0, assignment);
  });
  await expect.poll(() => f.statuses.includes("runner_lease_refused")).toBe(true);
  await f.connection.close();
  expect(f.opens).toBe(0);
});
it("advertises a native lease only after the task runtime has finished starting", async () => {
  const advertised: string[][] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    (socket, message) => {
      if (message.method === "runner.hello") hello(socket);
      if (message.method === "runner.heartbeat")
        advertised.push(parse(RunnerHeartbeatSchema, message.params).leaseIds);
    },
    {
      task: async () => {
        await ready;
        return {
          async update() {},
          async command() {
            return { ok: true };
          },
          async close() {},
        };
      },
    },
  );
  try {
    await expect.poll(() => f.opens).toBe(1);
    await expect.poll(() => advertised.length).toBeGreaterThan(0);
    expect(advertised.every((ids) => !ids.length)).toBe(true);
    release();
    await expect.poll(() => advertised.some((ids) => ids.includes("lease"))).toBe(true);
  } finally {
    release();
  }
});

it("stops native tasks once after explicit credential revocation instead of retrying authority", async () => {
  let hellos = 0;
  const f = await fixture(
    (socket, message) => {
      if (message.method === "runner.hello") {
        hellos++;
        hello(socket);
      }
    },
    {},
    1500,
  );
  await expect.poll(() => f.opens).toBe(1);
  f.credentialsError(new RunnerAccessRevokedError());
  await expect.poll(() => f.closes, { timeout: 5000 }).toBe(1);
  expect(f.statuses).toContain("runner_access_revoked");
  expect(hellos).toBe(1);
  expect(() => f.connection.start()).toThrow("runner_connection_closed");
  await f.connection.close();
  expect(f.closes).toBe(1);
});
it("keeps the native task through a transient credential outage and reconnects without another runtime", async () => {
  let hellos = 0;
  const f = await fixture((socket, message) => {
    if (message.method === "runner.hello") {
      hellos++;
      hello(socket);
    }
  });
  await expect.poll(() => f.opens).toBe(1);
  f.credentialsError(new Error("fixture_network_unavailable"));
  for (const socket of f.server.clients) socket.close();
  await expect.poll(() => f.statuses.includes("runner_connection_unavailable")).toBe(true);
  expect(f.closes).toBe(0);
  f.credentialsError(undefined);
  await expect.poll(() => hellos, { timeout: 5000 }).toBe(2);
  expect(f.opens).toBe(1);
  await f.connection.close();
  expect(f.closes).toBe(1);
});

it("reports native cleanup failure and closes the journal instead of claiming successful shutdown", async () => {
  const f = await fixture(
    (socket, message) => {
      if (message.method === "runner.hello") hello(socket);
    },
    {
      task: async () => ({
        async update() {},
        async command() {
          return {};
        },
        async close() {
          throw new Error("fixture_cleanup_failed");
        },
      }),
    },
  );
  await expect.poll(() => f.opens).toBe(1);
  await expect(f.connection.close()).rejects.toThrow("runner_cleanup_required");
  expect(() => f.append()).toThrow("runner_outbox_closed");
  // The expected failing close already settled; retain the server/directory cleanup hooks.
  cleanup.pop();
});

it("stops an active native task when the Cell explicitly closes access as forbidden", async () => {
  const f = await fixture((socket, message) => {
    if (message.method === "runner.hello") hello(socket);
  });
  await expect.poll(() => f.opens).toBe(1);
  for (const socket of f.server.clients) socket.close(1008, "forbidden");
  await expect.poll(() => f.closes).toBe(1);
  expect(f.statuses).toContain("runner_access_revoked");
  expect(() => f.connection.start()).toThrow("runner_connection_closed");
});
it("treats a refused authenticated WebSocket upgrade as lost authority rather than an outage", async () => {
  const f = await fixture(() => {}, {}, 600000, true);
  await expect.poll(() => f.statuses.includes("runner_access_revoked")).toBe(true);
  expect(f.opens).toBe(0);
  expect(() => f.connection.start()).toThrow("runner_connection_closed");
});
