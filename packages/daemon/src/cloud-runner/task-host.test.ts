import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import type { AgentEvent, InteractionAnswer } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { referenceCapabilities } from "../../../../tools/fakes/src/capabilities.js";
import { type ConnectedTask, RunnerConnection } from "./connection.js";
import { runnerLease } from "./fixture.js";
import { RunnerOutbox } from "./outbox.js";
import { cloudTasks } from "./task-host.js";
import { ManagedWorkspaces } from "./workspaces.js";

class Native implements AgentSession {
  readonly capabilities = referenceCapabilities;
  readonly queue = new AsyncQueue<AgentEvent>();
  sends = 0;
  closed = false;
  constructor(readonly nativeId: string) {
    void this.queue.push({
      t: "session.ready",
      nativeId,
      capabilities: this.capabilities,
      providerVersion: "fixture",
    });
  }
  events() {
    return this.queue;
  }
  async send() {
    const turnId = `native-turn-${++this.sends}`;
    await this.queue.push({ t: "turn.started", turnId });
    await this.queue.push({
      t: "message.done",
      turnId,
      itemId: "message",
      text: "Synthetic result",
      phase: "final",
    });
    await this.queue.push({ t: "turn.done", turnId, status: "completed" });
    return { disposition: "started" as const };
  }
  async interrupt() {}
  async respond(_id: string, _answer: InteractionAnswer) {}
  async setModel() {}
  async setMode() {}
  async compact() {}
  async rename() {}
  async contextUsage() {
    return undefined;
  }
  async close() {
    this.closed = true;
    this.queue.close();
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-cloud-task-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    remote = path.join(root, "remote.git");
  await mkdir(source);
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  git(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "README.md"), "Synthetic repository\n");
  git(source, ["add", "."]);
  git(source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Seed",
  ]);
  git(root, ["clone", "--bare", source, remote]);
  const lease = runnerLease(),
    execution = lease.execution;
  if (!execution) throw new Error("fixture_execution_missing");
  execution.definition.adapter = "reference";
  const definition = structuredClone(execution.definition);
  definition.launch = { command: "pinned-fake", args: [], env: {} };
  const outbox = new RunnerOutbox({
    directory: path.join(root, "outbox"),
    binding: { orgId: "org", taskId: "task", threadId: "thread", leaseId: "lease" },
    guard() {},
  });
  outbox.reconcile(0);
  cleanup.push(async () => outbox.close());
  const natives: Native[] = [],
    modes: string[] = [],
    statuses: string[] = [];
  const vault = new Map<string, unknown>();
  let assertPublic: (value: unknown) => Promise<void> = async () => {};
  let currentStore: Store | undefined;
  let currentCwd = "";
  let closes = 0,
    publications = 0;
  const controller = new AbortController();
  const create = cloudTasks({
    orgId: "org",
    memberId: "member",
    cacheDirectory: path.join(root, "cache"),
    workspaces: new ManagedWorkspaces({
      directory: path.join(root, "managed"),
      localRepository: () => remote,
    }),
    definition: async () => definition,
    guard() {},
    status: (code) => statuses.push(code),
    resources: async ({ cwd, signal, store }) => {
      currentStore = store;
      currentCwd = cwd;
      return {
        assertPublic: (value) => assertPublic(value),
        secrets: {
          async put(value) {
            const reference = `keychain:zoltbot:${randomUUID()}`;
            vault.set(reference, structuredClone(value));
            return { reference };
          },
          async read(reference) {
            return structuredClone(vault.get(reference));
          },
        },
        host: {
          async prepare(input) {
            expect(input.definition.launch.command).toBe("pinned-fake");
            if (signal.aborted) throw new Error("fixture_host_canceled");
            return {
              cwd,
              estimate: (text) => text.length,
              async open(request) {
                modes.push(request.mode);
                const native = new Native(request.nativeId ?? "original-native");
                natives.push(native);
                return native;
              },
            };
          },
        },
        async close() {
          closes++;
          for (const native of natives) await native.close();
        },
      };
    },
  });
  const start = async () => {
    const task = await create(
      lease,
      outbox,
      () => {
        publications++;
      },
      controller.signal,
    );
    cleanup.push(() => task.close());
    return task;
  };
  return {
    root,
    remote,
    setPrivacyGuard(guard: (value: unknown) => Promise<void>) {
      assertPublic = guard;
    },
    lease,
    execution,
    get store() {
      if (!currentStore) throw new Error("fixture_store_missing");
      return currentStore;
    },
    get cwd() {
      return currentCwd;
    },
    create,
    outbox,
    natives,
    modes,
    statuses,
    start,
    controller,
    get closes() {
      return closes;
    },
    get publications() {
      return publications;
    },
  };
}
const done = (f: Awaited<ReturnType<typeof fixture>>) =>
  [...f.outbox.pending(0, 64)].filter((frame) => frame.event.t === "turn.done").length;

it("collects a bounded diff only from its managed checkout and current task revision", async () => {
  const f = await fixture(),
    task = await f.start();
  await writeFile(path.join(f.cwd, "README.md"), "Updated task content\n");
  const revision = Number(f.store.record("task", "task")?.revision);
  const command = {
    taskId: "task",
    leaseId: "lease",
    commandId: "diff",
    command: { type: "collect_diff" as const, revision },
  };
  const result = (await task.command(command, f.controller.signal)) as {
    taskId: string;
    revision: number;
    patch: string;
    paths: string[];
  };
  expect(result.taskId).toBe("task");
  expect(result.revision).toBe(revision);
  expect(result.paths).toContain("README.md");
  expect(result.patch).toContain("+Updated task content");
  await expect(
    task.command(
      { ...command, command: { ...command.command, revision: revision + 1 } },
      f.controller.signal,
    ),
  ).rejects.toThrow("stale_revision");
  expect(await readFile(path.join(f.root, "source", "README.md"), "utf8")).toBe(
    "Synthetic repository\n",
  );
});

it("drives a leased task through InProcessRunner and durably publishes normalized events before readiness", async () => {
  const f = await fixture(),
    task = await f.start();
  expect(task.ready?.()).toBe(true);
  await expect.poll(() => done(f)).toBe(1);
  expect(f.natives).toHaveLength(1);
  expect(f.natives[0]?.sends).toBe(1);
  expect([...f.outbox.pending(0, 64)][0]?.event.t).toBe("session.ready");
  expect(f.publications).toBeGreaterThan(0);
  expect(f.statuses).toEqual([]);
  await task.update(f.lease);
  expect(f.natives[0]?.sends).toBe(1);
});

it("delivers a private answer once and restores its output redaction on native resume", async () => {
  const f = await fixture();
  let task = await f.start();
  await expect.poll(() => done(f)).toBe(1);
  const native = f.natives[0];
  if (!native) throw new Error("fixture_native_missing");
  await native.queue.push({ t: "turn.started", turnId: "private-turn" });
  await native.queue.push({
    t: "interaction.requested",
    interaction: {
      id: "private-request",
      nativeRef: "native-private",
      agentId: f.execution.profile.id,
      threadId: "thread",
      taskId: "task",
      turnId: "private-turn",
      type: "question",
      items: [{ id: "q", prompt: "Private value", secret: true }],
      chain: [],
      urgency: "blocking",
    },
  });
  const request = () =>
    [...f.outbox.pending(0, 64)].find((frame) => frame.event.t === "interaction.requested");
  await expect.poll(() => request() !== undefined).toBe(true);
  const frame = request();
  if (frame?.event.t !== "interaction.requested") throw new Error("fixture_request_missing");
  const privateValue = randomBytes(32).toString("base64url");
  let replies = 0;
  native.respond = async (_id, answer) => {
    replies++;
    expect(answer.answers?.q?.value === privateValue).toBe(true);
  };
  const command = {
    taskId: "task",
    leaseId: "lease",
    commandId: "private-answer",
    command: {
      type: "answer_interaction" as const,
      interactionId: frame.event.interaction.id,
      nativeRef: "native-private",
      version: 1,
      answer: {
        action: "accept" as const,
        answers: { q: { value: privateValue } },
        by: { kind: "human" as const, id: "member" },
        at: new Date().toISOString(),
      },
    },
  };
  await task.command(command, f.controller.signal);
  await task.command(command, f.controller.signal);
  expect(replies).toBe(1);
  await native.queue.push({ t: "turn.done", turnId: "private-turn", status: "completed" });
  await expect.poll(() => done(f)).toBe(2);
  await task.close();
  task = await f.start();
  const resumed = f.natives[1];
  if (!resumed) throw new Error("fixture_resume_missing");
  expect(resumed.closed).toBe(false);
  expect(f.modes).toEqual(["new", "resume"]);
  await resumed.queue.push({ t: "turn.started", turnId: "resumed-turn" });
  await resumed.queue.push({
    t: "message.done",
    turnId: "resumed-turn",
    itemId: "private-echo",
    text: `Echo ${privateValue}`,
    phase: "final",
  });
  await resumed.queue.push({ t: "turn.done", turnId: "resumed-turn", status: "completed" });
  await expect.poll(() => done(f)).toBe(3);
  expect(f.statuses).toEqual([]);
  expect(JSON.stringify(f.store.snapshot()).includes(privateValue)).toBe(false);
  expect(task.ready?.()).toBe(true);
  expect((await readFile(f.outbox.file, "utf8")).includes(privateValue)).toBe(false);
  expect(JSON.stringify([...f.outbox.pending(0, 64)])).toContain("[redacted]");
});

it("replays a command once and resumes the same native session after closing and reopening the task host", async () => {
  const f = await fixture();
  let task = await f.start();
  await expect.poll(() => done(f)).toBe(1);
  const command = {
    taskId: "task",
    leaseId: "lease",
    commandId: "follow-up",
    command: {
      type: "send_turn" as const,
      inputId: "canonical-follow-up",
      input: [{ type: "text" as const, text: "Follow up" }],
      mode: "queue" as const,
    },
  };
  const result = await task.command(command, f.controller.signal);
  expect(await task.command(command, f.controller.signal)).toEqual(result);
  await expect.poll(() => done(f)).toBe(2);
  expect(f.natives[0]?.sends).toBe(2);
  const nextSequence = f.outbox.nextSequence;
  await task.close();
  expect(task.ready?.()).toBe(false);
  task = await f.start();
  expect(f.modes).toEqual(["new", "resume"]);
  expect(f.natives[1]?.nativeId).toBe("original-native");
  expect(f.natives[1]?.sends).toBe(0);
  expect(f.outbox.nextSequence).toBeGreaterThan(nextSequence);
  expect(done(f)).toBe(2);
});

it("withdraws readiness on stop, resumes on a fresh lease, and closes only its native resources on abort", async () => {
  const f = await fixture(),
    task = await f.start();
  await expect.poll(() => done(f)).toBe(1);
  await task.command(
    { taskId: "task", leaseId: "lease", commandId: "stop", command: { type: "stop" } },
    f.controller.signal,
  );
  expect(task.ready?.()).toBe(false);
  await task.update(f.lease);
  expect(task.ready?.()).toBe(true);
  expect(f.modes).toEqual(["new", "resume"]);
  f.controller.abort();
  await task.close();
  expect(task.ready?.()).toBe(false);
  expect(f.natives.every((native) => native.closed)).toBe(true);
  expect(f.closes).toBe(1);
});

it("refuses cross-member work and commands for a different task or lease", async () => {
  const f = await fixture(),
    task: ConnectedTask = await f.start();
  await expect(
    task.command(
      { taskId: "other", leaseId: "lease", commandId: "other", command: { type: "stop" } },
      f.controller.signal,
    ),
  ).rejects.toThrow("runner_task_scope_conflict");
  const changed = structuredClone(f.lease);
  changed.actor.userId = "other";
  await expect(f.create(changed, f.outbox, () => {}, f.controller.signal)).rejects.toThrow(
    "runner_task_unavailable",
  );
  expect(f.natives).toHaveLength(1);
});

it("keeps one native runtime and replays its journal through a disconnect from a localhost fake Cell", async () => {
  const f = await fixture();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_server_missing");
  const credential = randomBytes(32).toString("base64url");
  let cursor = 0,
    hellos = 0,
    completions = 0,
    disconnected = false;
  const applied = new Set<number>();
  server.on("connection", (socket, request) => {
    let abandoned = false;
    expect(request.headers.authorization).toBe(`Bearer ${credential}`);
    socket.on("message", (data) => {
      if (abandoned) return;
      const message = JSON.parse(data.toString());
      const send = (method: string, params: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: method, method, params }));
      if (message.method === "runner.hello") {
        hellos++;
        send("runner.ack", { taskId: "task", runnerSeq: cursor });
        send("runner.lease", f.lease);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", result: { ok: true } }));
      }
      if (message.method === "runner.event") {
        const frame = message.params;
        if (!applied.has(frame.runnerSeq)) {
          expect(frame.runnerSeq).toBe(cursor + 1);
          applied.add(frame.runnerSeq);
          cursor = frame.runnerSeq;
          if (frame.event.t === "turn.done") completions++;
        }
        if (!disconnected) {
          disconnected = true;
          abandoned = true;
          socket.terminate();
        } else send("runner.ack", { taskId: "task", runnerSeq: cursor });
      }
    });
  });
  const connection = new RunnerConnection({
    orgId: "org",
    hello: {
      kind: "mac",
      runnerId: "runner",
      acceptTasks: true,
      protocolVersion: 1,
      versions: {},
      clis: [],
      sleepKeepsProcesses: true,
    },
    outboxDirectory: path.join(f.root, "connection-outbox"),
    guard() {},
    task: f.create,
    credentials: async () => ({
      url: `ws://127.0.0.1:${address.port}/v1/orgs/org/connect`,
      token: credential,
      expiresAt: Date.now() + 600000,
    }),
    allowLoopback: true,
    retryBaseMs: 10,
  });
  cleanup.push(() => connection.close());
  connection.start();
  await expect.poll(() => completions, { timeout: 10000 }).toBe(1);
  expect(hellos).toBeGreaterThanOrEqual(2);
  expect(f.natives).toHaveLength(1);
  expect(f.natives[0]?.sends).toBe(1);
  expect(applied.size).toBe(cursor);
});

it("publishes the current reviewed task commit through its pinned repository and refuses stale or private history", async () => {
  const f = await fixture(),
    task = await f.start();
  await expect.poll(() => done(f)).toBe(1);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: f.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  await writeFile(path.join(f.cwd, "README.md"), "Reviewed result\n");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Reviewed change",
  ]);
  const head = git(["rev-parse", "HEAD"]),
    revision = Number(f.store.record("task", "task")?.revision);
  const frame = {
    taskId: "task",
    leaseId: "lease",
    commandId: "publish",
    command: { type: "push_branch" as const, head, revision, branch: "zoltbot/review" },
  };
  await expect(
    task.command(
      { ...frame, command: { ...frame.command, revision: revision + 1 } },
      f.controller.signal,
    ),
  ).rejects.toThrow("stale_revision");
  f.setPrivacyGuard(async (value) => {
    if (typeof value === "string" && value.includes("Reviewed result\n"))
      throw new Error("private_context");
  });
  await expect(task.command(frame, f.controller.signal)).rejects.toThrow(
    "managed_publication_unavailable",
  );
  expect(
    execFileSync("git", ["ls-remote", "--heads", f.remote, "refs/heads/zoltbot/review"], {
      encoding: "utf8",
    }),
  ).toBe("");
  f.setPrivacyGuard(async () => {});
  expect(await task.command(frame, f.controller.signal)).toEqual({
    taskId: "task",
    revision,
    head,
    branch: "zoltbot/review",
    repository: f.execution.project.cloud?.repository,
    pushed: true,
  });
  expect(await task.command(frame, f.controller.signal)).toEqual({
    taskId: "task",
    revision,
    head,
    branch: "zoltbot/review",
    repository: f.execution.project.cloud?.repository,
    pushed: true,
  });
});
