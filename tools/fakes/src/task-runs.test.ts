import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Daemon, type DaemonOptions, startDaemon } from "@zoltbot/daemon";
import { type EntityKind, protocolVersion } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

type Rpc = (
  method: string,
  params: Record<string, unknown>,
  commandId?: string,
) => Promise<Record<string, unknown>>;
async function connect(daemon: Daemon): Promise<{ call: Rpc; close(): void }> {
  const socket = new WebSocket(daemon.url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("fixture_socket_failed")), {
      once: true,
    });
  });
  let id = 0;
  const pending = new Map<
    number,
    { resolve(v: Record<string, unknown>): void; reject(e: Error): void }
  >();
  socket.addEventListener("message", (message) => {
    const value = JSON.parse(String(message.data)) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    if (value.id === undefined) return;
    const waiter = pending.get(value.id);
    pending.delete(value.id);
    if (value.error) waiter?.reject(new Error(value.error.message));
    else waiter?.resolve(value.result ?? {});
  });
  const call: Rpc = (method, params, commandId) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: key,
          method,
          params,
          ...(commandId ? { commandId } : {}),
        }),
      );
    });
  await call("hello", { token: daemon.token, protocolVersion });
  return { call, close: () => socket.close() };
}
async function until(check: () => boolean, label: string) {
  for (let tries = 0; tries < 300 && !check(); tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!check()) throw new Error(`timed_out: ${label}`);
}
function seed(daemon: Daemon, rows: Record<string, unknown>[], kind: EntityKind, prefix: string) {
  for (const value of rows)
    daemon.dispatch({ type: "create", kind, value }, `${prefix}:${kind}:${String(value.id)}`);
}
const project = (roots: { path: string; label: string }[]) => ({
  id: "zolt",
  name: "Zolt",
  goal: "",
  instructions: "",
  constraints: "",
  roots,
  hierarchyDepth: 3,
  tags: [],
  requireCodeReview: false,
  skipFinalGateWhenReviewed: false,
  archived: false,
  createdAt: at,
});
function referenceHost(root: string, prompts: string[]): NonNullable<DaemonOptions["runtimeHost"]> {
  return {
    async prepare(input) {
      return {
        cwd: root,
        estimate: (text) => text.length,
        async open(request) {
          const session = await new ReferenceSession({
            identity: { agentId: input.profile.id, threadId: input.thread.id },
            mode: request.mode,
            ...(request.nativeId ? { nativeId: request.nativeId } : {}),
            cwd: root,
            permissionProfile: "read_only",
            hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
          }).open();
          const send = session.send.bind(session);
          session.send = (value, mode) => {
            prompts.push(JSON.stringify(value));
            return send(value, mode);
          };
          return session;
        },
      };
    },
  };
}
const task = (daemon: Daemon, id: string) =>
  daemon.store.snapshot(["task"]).task?.find((row) => row.id === id) ?? {};

it("runs a task in a fresh native conversation, reviews it and runs revision 2 in the same thread", async () => {
  const test = await runtimeFixture();
  let daemon: Daemon | undefined, client: { call: Rpc; close(): void } | undefined;
  const prompts: string[] = [];
  try {
    daemon = await startDaemon({
      dataDir: path.join(test.root, "daemon"),
      runtimeHost: referenceHost(test.root, prompts),
    });
    for (const kind of ["agentDefinition", "agent"] as const)
      seed(daemon, test.store.snapshot()[kind] ?? [], kind, "seed");
    seed(daemon, [project([])], "project", "seed");
    client = await connect(daemon);
    const created = await client.call(
      "task.create",
      {
        title: "Units",
        brief: "Show grams and ounces",
        acceptance: "Both units render",
        profileId: "profile",
        node: { type: "project", id: "zolt" },
      },
      "create:units",
    );
    expect(created).toMatchObject({
      state: "queued",
      revision: 1,
      threadId: `${created.id}:thread`,
    });
    const id = String(created.id);
    await until(() => task(daemon as Daemon, id).state === "review", "first review");
    expect(prompts[0]).toContain("Show grams and ounces");
    expect(daemon.store.snapshot(["taskResult"]).taskResult).toEqual([
      expect.objectContaining({ taskId: id, revision: 1, summary: "ok", auto: true }),
    ]);
    const thread = daemon.store
      .snapshot(["thread"])
      .thread?.find((row) => row.id === created.threadId);
    expect(thread).toMatchObject({
      kind: "task",
      taskId: id,
      node: { type: "project", id: "zolt" },
    });
    await expect(
      client.call(
        "task.review",
        { id, revision: 1, decision: "changes", confirmed: true },
        "review:empty",
      ),
    ).rejects.toThrow("feedback_required");
    await client.call(
      "task.review",
      { id, revision: 1, decision: "changes", feedback: "Round to one decimal", confirmed: true },
      "review:1",
    );
    await until(() => task(daemon as Daemon, id).state === "review", "second review");
    expect(task(daemon, id)).toMatchObject({ revision: 2 });
    expect(prompts[1]).toContain("Round to one decimal");
    expect(prompts[1]).not.toContain("Show grams and ounces");
    const sessions = daemon.store
      .snapshot(["session"])
      .session?.filter((row) => row.threadId === created.threadId);
    expect(new Set(sessions?.map((row) => row.nativeId)).size).toBe(1);
    await client.call(
      "task.review",
      { id, revision: 2, decision: "accept", confirmed: true },
      "review:2",
    );
    expect(task(daemon, id)).toMatchObject({ state: "completed", revision: 2 });
    expect(daemon.store.snapshot(["taskResult"]).taskResult).toHaveLength(2);
  } finally {
    client?.close();
    await daemon?.close();
    test.close();
  }
});

it("runs one task per code folder, holds the rest with a reason, stops and resumes after restart", async () => {
  const test = await runtimeFixture();
  const folder = path.join(test.root, "code");
  mkdirSync(folder);
  const options: DaemonOptions = { dataDir: path.join(test.root, "daemon") };
  let daemon: Daemon | undefined = await startDaemon(options),
    client: { call: Rpc; close(): void } | undefined;
  try {
    for (const kind of ["agentDefinition", "agent"] as const)
      seed(daemon, test.store.snapshot()[kind] ?? [], kind, "seed");
    seed(daemon, [project([{ path: folder, label: "code" }])], "project", "seed");
    client = await connect(daemon);
    const make = (title: string) =>
      client?.call(
        "task.create",
        {
          title,
          brief: `Do ${title}`,
          profileId: "profile",
          node: { type: "project", id: "zolt" },
        },
        `create:${title}`,
      ) as Promise<Record<string, unknown>>;
    const first = await make("First");
    const second = await make("Second");
    const [a, b] = [String(first.id), String(second.id)];
    await until(() => task(daemon as Daemon, b).holdReason !== undefined, "hold");
    expect(task(daemon, a)).toMatchObject({ state: "running" });
    expect(task(daemon, b)).toMatchObject({
      state: "queued",
      holdReason: 'Waiting for "First" to finish in code',
    });
    // A turn that ends in the first task's thread becomes its result and frees the folder.
    const threadId = String(first.threadId);
    daemon.dispatch(
      {
        type: "create",
        kind: "session",
        value: {
          id: "s1",
          threadId,
          provider: "reference",
          cwd: folder,
          state: "starting",
          capabilities: {},
          startedAt: at,
        },
      },
      "session:s1",
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "turn",
        value: {
          id: "turn-1",
          threadId,
          sessionId: "s1",
          status: "running",
          origin: "human",
          startedAt: at,
        },
      },
      "turn:1",
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "item",
        value: {
          id: "reply",
          threadId,
          turnId: "turn-1",
          seq: 9,
          kind: "message",
          phase: "final",
          body: { text: "First is done." },
          createdAt: at,
          updatedAt: at,
        },
      },
      "item:reply",
    );
    const brief = daemon.store.record("item", `${a}:r1:input`) as { body: object };
    daemon.dispatch(
      {
        type: "update",
        kind: "item",
        id: `${a}:r1:input`,
        changes: { body: { ...brief.body, queueState: "sent" } },
      },
      "item:brief:sent",
    );
    daemon.dispatch(
      { type: "transition", kind: "turn", id: "turn-1", to: "completed" },
      "turn:1:done",
    );
    await until(() => task(daemon as Daemon, a).state === "review", "first result");
    await until(() => task(daemon as Daemon, b).state === "running", "second starts");
    expect(task(daemon, b).holdReason).toBeUndefined();
    expect(daemon.store.snapshot(["taskResult"]).taskResult?.[0]).toMatchObject({
      taskId: a,
      summary: "First is done.",
    });
    await expect(
      client.call(
        "task.review",
        { id: a, revision: 9, decision: "accept", confirmed: true },
        "review:stale",
      ),
    ).rejects.toThrow("stale_revision");
    // Restart while the second task runs. Recovery parks it and the runner continues it.
    client.close();
    await daemon.close();
    const prompts: string[] = [];
    daemon = await startDaemon({ ...options, runtimeHost: referenceHost(folder, prompts) });
    client = await connect(daemon);
    await until(() => task(daemon as Daemon, b).state === "review", "resumed result");
    expect(prompts.some((text) => text.includes("Zoltbot restarted"))).toBe(true);
    expect(task(daemon, b).holdReason).toBeUndefined();
    await expect(
      client.call("task.cancel", { id: b, confirmed: false }, "stop:unconfirmed"),
    ).rejects.toThrow("confirmation_required");
    await client.call("task.cancel", { id: b, confirmed: true }, "stop:b");
    expect(task(daemon, b)).toMatchObject({ state: "cancelled", holdReason: "Stopped by you" });
    const listed = await client.call("task.list", { projectId: "zolt" });
    expect(listed.items).toHaveLength(2);
  } finally {
    client?.close();
    await daemon?.close();
    test.close();
  }
});

it("creates and fires a routine through the daemon runner, records its outcome, and recovers a mid-run restart without another occurrence", async () => {
  const f = await runtimeFixture();
  let now = "2026-11-04T00:00:00.000Z",
    hold = false;
  const opens: { threadId: string; mode: string; ceiling: string }[] = [];
  const options: DaemonOptions = {
    dataDir: path.join(f.root, "routines-daemon"),
    routineClock: () => now,
    routinePollMs: 10,
    runtimeHost: {
      async prepare(input) {
        const cwd = path.join(f.root, input.thread.id.replace(/[^a-z0-9-]/gi, "_"));
        mkdirSync(cwd, { recursive: true });
        return {
          cwd,
          estimate: (text) => Math.ceil(text.length / 4),
          async open(request) {
            opens.push({
              threadId: input.thread.id,
              mode: request.mode,
              ceiling: input.profile.permissionProfile,
            });
            const session = await new ReferenceSession({
              identity: { agentId: input.profile.id, threadId: input.thread.id },
              mode: request.mode,
              ...(request.nativeId ? { nativeId: request.nativeId } : {}),
              cwd,
              permissionProfile: input.profile.permissionProfile,
              env: {
                REFERENCE_NATIVE_ID: input.thread.id,
                REFERENCE_FINAL_TEXT: "Checked.\n[ZOLTBOT_OUTCOME:nothing]",
              },
              hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
            }).open();
            const send = session.send.bind(session);
            session.send = (value, mode) =>
              send(
                hold && input.thread.taskId?.startsWith("run:")
                  ? [{ type: "text", text: "hang" }]
                  : value,
                mode,
              );
            return session;
          },
        };
      },
    },
  };
  let daemon: Daemon | undefined, client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    daemon = await startDaemon(options);
    for (const kind of ["agentDefinition", "agent"] as const)
      seed(daemon, f.store.snapshot()[kind] ?? [], kind, "seed");
    seed(daemon, [project([])], "project", "seed");
    client = await connect(daemon);
    const source = await client.call(
      "task.create",
      {
        title: "Daily check",
        brief: "Check",
        profileId: "profile",
        node: { type: "project", id: "zolt" },
      },
      "manual-check",
    );
    await until(
      () => task(daemon as Daemon, String(source.id)).state === "review",
      "manual result",
    );
    const routine = await client.call(
      "routine.create",
      {
        taskId: source.id,
        name: "Daily check",
        schedule: { cron: "@every 60m", timezone: "UTC" },
        notify: "actionable_only",
        permissionCeiling: "full_access",
      },
      "routine-check",
    );
    expect(routine.permissionCeiling).toBe("read_only");
    now = String(routine.nextRunAt);
    const runs = () => daemon?.store.snapshot(["routineOccurrence"]).routineOccurrence ?? [];
    await until(() => runs()[0]?.status === "completed", "routine result");
    expect(runs()[0]).toMatchObject({ outcome: "nothing" });
    const firstId = String(runs()[0]?.taskId);
    expect(daemon.store.record("task", firstId)).toMatchObject({
      revision: 1,
      permissionCeiling: "read_only",
    });
    expect(opens.filter((open) => open.threadId === `${firstId}:thread`)).toEqual([
      { threadId: `${firstId}:thread`, mode: "new", ceiling: "read_only" },
    ]);
    hold = true;
    now = "2026-11-04T02:00:00.000Z";
    await until(() => runs()[1]?.status === "started", "second occurrence started");
    const secondId = String(runs()[1]?.taskId);
    await until(
      () => opens.some((open) => open.threadId === `${secondId}:thread`),
      "native opened",
    );
    await until(
      () =>
        (daemon?.store.snapshot(["item"]).item ?? []).some(
          (row) =>
            row.threadId === `${secondId}:thread` &&
            row.kind === "user" &&
            (row.body as { queueState?: string }).queueState === "sent",
        ),
      "routine input dispatched",
    );
    client.close();
    await daemon.close();
    hold = false;
    daemon = await startDaemon(options);
    client = await connect(daemon);
    await until(() => runs()[1]?.status === "completed", "restart result");
    expect(runs()).toHaveLength(2);
    expect(runs()[1]).toMatchObject({ taskId: secondId, outcome: "nothing" });
    expect(
      opens.filter((open) => open.threadId === `${secondId}:thread`).map((open) => open.mode),
    ).toEqual(["new", "resume"]);
    expect((await client.call("routine.history", { id: routine.id })).items).toHaveLength(2);
  } finally {
    client?.close();
    await daemon?.close();
    f.close();
  }
});
