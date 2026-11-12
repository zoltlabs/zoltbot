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
