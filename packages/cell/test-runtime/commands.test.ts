import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { requestInteraction } from "@zoltbot/core";
import { Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CellCommands } from "../src/commands.js";
import { CellLeases } from "../src/leases.js";
import type { SocketAttachment } from "../src/sockets.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import { sandboxFixture } from "./sandbox-fixture.js";

function claims(): CellTokenClaims {
  return {
    iss: env.CELL_JWT_ISSUER,
    aud: "cell",
    org: "org",
    sub: "member",
    device: "runner",
    kind: "sandbox_runner",
    surface: "runner",
    task: "task",
    iat: 1,
    exp: 9999999999,
    jti: "test",
  };
}
function socket(sent: unknown[], identity = claims()) {
  const data: SocketAttachment = {
    claims: identity,
    runnerId: identity.device,
    connectionId: "connection",
    lastSeq: 0,
    subscribed: false,
  };
  return {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => data,
    send: (body: string) => sent.push(JSON.parse(body)),
  } as unknown as WebSocket;
}
function diff() {
  return {
    taskId: "task",
    revision: 1,
    base: "a".repeat(40),
    head: "b".repeat(40),
    patch: "+change",
    status: " M file.ts",
    paths: ["file.ts"],
    files: [{ path: "file.ts", added: 1, removed: 0, binary: false, patch: "+change" }],
    uncommittedFiles: [],
    provenance: "Task base to working tree.",
    patchIncomplete: false,
    capturedAt: "2026-11-12T00:00:00Z",
  };
}
it("retains bounded revision-bound diffs through eviction and refuses foreign or malformed results", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", claims());
    const commands = new CellCommands(store);
    commands.enqueue("task", "diff", { type: "collect_diff", revision: 1 });
    expect(commands.collected("task", "diff")).toEqual({ state: "pending" });
    for (const result of [
      { ...diff(), taskId: "other" },
      { ...diff(), revision: 2 },
      { ...diff(), extra: "untrusted" },
    ]) {
      expect(() =>
        commands.result(claims(), "runner", { id: "runner-command:diff", result }),
      ).toThrow();
    }
    expect(() =>
      commands.result({ ...claims(), device: "other" }, "other", {
        id: "runner-command:diff",
        result: diff(),
      }),
    ).toThrow("forbidden");
    expect(commands.pending("task")).toBe(true);
    commands.result(claims(), "runner", { id: "runner-command:diff", result: diff() });
    commands.result(claims(), "runner", { id: "runner-command:diff", result: diff() });
    expect(() => commands.collected("other", "diff")).toThrow("forbidden");
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const commands = new CellCommands(new Store(new CellSqlDriver(state.storage)));
    expect(commands.collected("task", "diff")).toEqual({ state: "complete", result: diff() });
    expect(commands.pending("task")).toBe(false);
  });
});
it("retains only four diff snapshots and reports an expired snapshot as failed", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", claims());
    const commands = new CellCommands(store);
    for (let index = 0; index < 5; index++) {
      commands.enqueue("task", `diff:${index}`, { type: "collect_diff", revision: 1 });
      commands.result(claims(), "runner", { id: `runner-command:diff:${index}`, result: diff() });
    }
    expect(
      store.database.prepare("SELECT count(*) AS n FROM cell_runner_command_results").get(),
    ).toEqual({ n: 4 });
    expect(commands.collected("task", "diff:0")).toEqual({ state: "failed" });
    expect(commands.collected("task", "diff:4")?.state).toBe("complete");
  });
});
it("replays a saved command with the same identity after eviction until its fenced acknowledgement", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  const initial = await runInDurableObject(stub, (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", claims());
    const commands = new CellCommands(store);
    const command = commands.enqueue("task", "checkpoint", { type: "interrupt" });
    expect(commands.enqueue("task", "checkpoint", { type: "interrupt" })).toEqual(command);
    expect(() => commands.enqueue("task", "checkpoint", { type: "stop" })).toThrow(
      "command_conflict",
    );
    const sent: unknown[] = [];
    const runner = socket(sent);
    commands.deliver(runner, false, 1000);
    commands.deliver(runner, false, 2000);
    expect(sent).toHaveLength(1);
    return sent[0];
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const commands = new CellCommands(store);
    const sent: unknown[] = [];
    commands.deliver(socket(sent), true, 2000);
    expect(sent).toEqual([initial]);
    expect(() =>
      commands.result({ ...claims(), device: "other" }, "other", {
        id: "runner-command:checkpoint",
        result: { ok: true },
      }),
    ).toThrow("forbidden");
    expect(() =>
      commands.result(claims(), "runner", {
        id: "runner-command:checkpoint",
        result: { ok: true, unexpected: "refuse arbitrary payload" },
      }),
    ).toThrow("forbidden");
    expect(commands.pending("task")).toBe(true);
    commands.result(claims(), "runner", { id: "runner-command:checkpoint", result: { ok: true } });
    commands.result(claims(), "runner", { id: "runner-command:checkpoint", result: { ok: true } });
    expect(commands.pending("task")).toBe(false);
    commands.deliver(socket(sent), true, 3000);
    expect(sent).toHaveLength(1);
  });
});

it("rolls a queued command back with its core transaction and stores only fixed runner error codes", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", claims());
    const commands = new CellCommands(store);
    expect(() =>
      store.dispatch(
        "rollback",
        () => {
          commands.enqueue("task", "rollback", { type: "stop" });
          return { events: [], result: null };
        },
        { scope: { taskId: "task" }, killPoint: "after_events" },
      ),
    ).toThrow("kill point");
    expect(commands.pending("task")).toBe(false);
    commands.enqueue("task", "stop", { type: "stop" });
    commands.result(claims(), "runner", {
      id: "runner-command:stop",
      error: { message: "arbitrary native error detail" },
    });
    expect(
      store.database.prepare("SELECT state,error_code FROM cell_runner_commands").all(),
    ).toEqual([{ state: "failed", error_code: "runner_command_failed" }]);
    expect(commands.pending("task")).toBe(false);
  });
});

it("refuses to persist a private native answer in the command queue", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", claims());
    const commands = new CellCommands(store);
    const at = new Date().toISOString();
    store.dispatch(
      "question",
      (snapshot) =>
        requestInteraction(
          snapshot,
          {
            id: "question",
            agentId: "cloud-claude",
            threadId: String(store.record("task", "task")?.threadId),
            taskId: "task",
            type: "question",
            urgency: "blocking",
            chain: [],
            items: [{ id: "answer", prompt: "Private answer", secret: true, allowOther: true }],
          },
          "question:item",
          { commandId: "question", at, actor: { kind: "system", id: "cell" } },
        ),
      { scope: { taskId: "task" } },
    );
    const value = crypto.randomUUID();
    expect(() =>
      commands.enqueue("task", "answer", {
        type: "answer_interaction",
        interactionId: "question",
        answer: {
          action: "accept",
          by: { kind: "human", id: "member" },
          at,
          answers: { answer: { other: value } },
        },
      }),
    ).toThrow("private_answer_requires_live_runner");
    expect(
      JSON.stringify(
        store.database.prepare("SELECT body FROM cell_runner_commands").all(),
      ).includes(value),
    ).toBe(false);
    expect(commands.pending("task")).toBe(false);
  });
});

it("fences exact-head publication results and preserves the proof across eviction", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  const result = await runInDurableObject(stub, (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", claims());
    const commands = new CellCommands(store);
    const task = store.record("task", "task"),
      project = store.record("project", String(task?.projectId));
    const repository = (project?.cloud as { repository: string }).repository;
    const result = {
      taskId: "task",
      revision: 1,
      head: "b".repeat(40),
      branch: "zoltbot/task",
      repository,
      pushed: true,
    };
    commands.enqueue("task", "push", {
      type: "push_branch",
      revision: 1,
      head: result.head,
      branch: result.branch,
    });
    expect(commands.published("task", "push")).toEqual({ state: "pending" });
    for (const changed of [
      { taskId: "other" },
      { revision: 2 },
      { head: "c".repeat(40) },
      { branch: "main" },
      { repository: "other/repository" },
      { extra: true },
    ]) {
      expect(() =>
        commands.result(claims(), "runner", {
          id: "runner-command:push",
          result: { ...result, ...changed },
        }),
      ).toThrow();
    }
    expect(() =>
      commands.result({ ...claims(), device: "other" }, "other", {
        id: "runner-command:push",
        result,
      }),
    ).toThrow("forbidden");
    commands.result(claims(), "runner", { id: "runner-command:push", result });
    commands.result(claims(), "runner", { id: "runner-command:push", result });
    expect(() => commands.published("other", "push")).toThrow("forbidden");
    expect(commands.pending("task")).toBe(false);
    return result;
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage)),
      commands = new CellCommands(store);
    expect(commands.published("task", "push")).toEqual({ state: "complete", result });
    expect(
      store.database.prepare("SELECT count(*) AS n FROM cell_runner_publications").get(),
    ).toEqual({ n: 1 });
  });
});
