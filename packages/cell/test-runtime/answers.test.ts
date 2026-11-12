import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { requestInteraction } from "@zoltbot/core";
import { type InteractionAnswer, parse, TaskSchema } from "@zoltbot/protocol";
import { Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CellAnswers } from "../src/answers.js";
import { CloudRpc } from "../src/cloud-rpc.js";
import { CellLeases } from "../src/leases.js";
import { CellService } from "../src/service.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import { sandboxFixture } from "./sandbox-fixture.js";

function identity(): CellTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: env.CELL_JWT_ISSUER,
    aud: "cell",
    org: "org",
    sub: "member",
    device: "runner",
    kind: "sandbox_runner",
    task: "task",
    surface: "runner",
    iat: now,
    exp: now + 3600,
    jti: "test",
  };
}
function liveLease(store: Store, now = Date.now(), connectionId = "test") {
  const leases = new CellLeases(store);
  const lease = leases.assign("task", "runner", identity(), now);
  leases.heartbeat("runner", [lease.leaseId], identity(), now, connectionId);
  return lease;
}
function question(store: Store, id: string, secret = false) {
  const task = parse(TaskSchema, store.record("task", "task"));
  store.dispatch(
    `question:${id}`,
    (state) =>
      requestInteraction(
        state,
        {
          id,
          agentId: "cloud-claude",
          threadId: task.threadId,
          taskId: task.id,
          type: "question",
          urgency: "blocking",
          chain: [],
          nativeRef: `native:${id}`,
          items: [{ id: "answer", prompt: "Answer", allowOther: true, secret }],
        },
        `question-item:${id}`,
        {
          commandId: `question:${id}`,
          at: new Date().toISOString(),
          actor: { kind: "system", id: "cell" },
        },
      ),
    { scope: { taskId: "task" } },
  );
}
function rpc(store: Store, answers: CellAnswers) {
  return new CloudRpc(
    store,
    { ...identity(), kind: "client", device: "phone", surface: "phone", session: "session" },
    new CellService(
      {
        origin: env.ORCHESTRATOR_URL,
        issuer: env.CELL_JWT_ISSUER,
        signingKey: env.ORCHESTRATOR_SIGNING_KEY,
      },
      "org",
    ),
    answers,
  );
}
function answer(value: string): InteractionAnswer {
  return {
    action: "accept",
    answers: { answer: { other: value } },
    by: { kind: "human", id: "forged" },
    device: "forged",
    automatic: true,
    at: new Date().toISOString(),
  };
}
function socket(sent: unknown[], claims = identity()) {
  return {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({
      claims,
      runnerId: claims.device,
      connectionId: "test",
      lastSeq: 0,
      subscribed: false,
    }),
    send: (message: string) => sent.push(JSON.parse(message)),
  } as unknown as WebSocket;
}
function request(id: string, value: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "interaction.answer",
    commandId: `answer:${id}`,
    params: { id, version: 1, answer: answer(value) },
  };
}
function stub() {
  return env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
}

it("replays an ordinary answer after eviction and accepts only its assigned runner's acknowledgement", async () => {
  const cell = stub();
  const first = await runInDurableObject(cell, async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", identity());
    question(store, "question");
    const answers = new CellAnswers(store);
    const api = rpc(store, answers);
    const input = request("question", "Continue");
    const result = await api.call(input);
    expect(await api.call(input)).toEqual(result);
    expect(store.record("interaction", "question")?.state).toBe("answered");
    const sent: unknown[] = [];
    answers.deliver(socket(sent), true);
    expect(sent).toHaveLength(1);
    const command = (
      sent[0] as {
        params: { command: { version: number; nativeRef: string; answer: InteractionAnswer } };
      }
    ).params.command;
    expect(command.version).toBe(1);
    expect(command.nativeRef).toBe("native:question");
    expect(command.answer.by).toEqual({ kind: "human", id: "member" });
    expect(command.answer.device).toBe("phone");
    expect(command.answer.automatic).toBeUndefined();
    return sent[0];
  });
  await evictDurableObject(cell);
  await runInDurableObject(cell, (_instance, state) => {
    const answers = new CellAnswers(new Store(new CellSqlDriver(state.storage)));
    const sent: unknown[] = [];
    answers.deliver(socket(sent), true);
    expect(sent).toEqual([first]);
    const id = (first as { id: string }).id;
    expect(() =>
      answers.receive({ ...identity(), device: "other" }, "other", { id, result: { ok: true } }),
    ).toThrow("forbidden");
    expect(() =>
      answers.receive(identity(), "runner", { id, result: { ok: true, extra: "refuse" } }),
    ).toThrow("forbidden");
    expect(answers.receive(identity(), "runner", { id, result: { ok: true } })).toBe(true);
    expect(answers.pending("task")).toBe(false);
    answers.deliver(socket(sent), true);
    expect(sent).toHaveLength(1);
  });
});

it("sends a private value live once while keeping it out of events, receipts and delivery rows", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    liveLease(store);
    question(store, "private", true);
    const sent: unknown[] = [];
    const native = socket(sent);
    const answers = new CellAnswers(store, { getWebSockets: () => [native] });
    const api = rpc(store, answers);
    const value = crypto.randomUUID();
    const input = request("private", value);
    await api.call(input);
    await api.call(input);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent).includes(value)).toBe(true);
    const durable = JSON.stringify({
      events: store.eventsSince(0),
      receipts: store.database.prepare("SELECT result FROM command_receipts").all(),
      deliveries: store.database.prepare("SELECT body FROM cell_answer_deliveries").all(),
    });
    expect(durable.includes(value)).toBe(false);
    answers.deliver(native, true);
    expect(sent).toHaveLength(1);
  });
});

it("rolls a mixed answer batch back when a private handoff has no live runner", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    new CellLeases(store).assign("task", "runner", identity());
    question(store, "public");
    question(store, "private", true);
    const api = rpc(store, new CellAnswers(store));
    await expect(
      api.call({
        jsonrpc: "2.0",
        id: 1,
        method: "interaction.batchAnswer",
        commandId: "batch",
        params: {
          items: [
            { id: "public", version: 1, answer: answer("Continue") },
            { id: "private", version: 1, answer: answer(crypto.randomUUID()) },
          ],
        },
      }),
    ).rejects.toThrow("runner_unavailable");
    expect(store.record("interaction", "public")?.state).toBe("pending");
    expect(store.record("interaction", "private")?.state).toBe("pending");
    expect(store.database.prepare("SELECT id FROM cell_answer_deliveries").all()).toEqual([]);
  });
});

it("reports a private handoff lost across eviction and reconciles a late acknowledgement", async () => {
  const cell = stub();
  let now = Date.now();
  const id = await runInDurableObject(cell, async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    liveLease(store, now);
    question(store, "private", true);
    const answers = new CellAnswers(store, { getWebSockets: () => [socket([])] }, () => now);
    await rpc(store, answers).call(request("private", crypto.randomUUID()));
    return (store.database.prepare("SELECT id FROM cell_answer_deliveries").get() as { id: string })
      .id;
  });
  await evictDurableObject(cell);
  now += 31000;
  await runInDurableObject(cell, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const answers = new CellAnswers(store, undefined, () => now);
    const sent: unknown[] = [];
    answers.deliver(socket(sent), true);
    expect(sent).toEqual([]);
    expect(answers.alarm()).toBeUndefined();
    const noteId = `answer-delivery-note:${id}`;
    expect((store.record("item", noteId)?.body as { code: string }).code).toBe(
      "interaction_reply_failed",
    );
    expect(answers.pending("task")).toBe(false);
    expect(
      answers.receive(identity(), "runner", { id: `runner-answer:${id}`, result: { ok: true } }),
    ).toBe(true);
    expect((store.record("item", noteId)?.body as { code: string }).code).toBe(
      "interaction_reply_confirmed",
    );
  });
});
it("refuses a private handoff until the current connection advertises the leased native task", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const lease = liveLease(store, Date.now(), "old-connection");
    question(store, "private", true);
    const sent: unknown[] = [];
    const answers = new CellAnswers(store, { getWebSockets: () => [socket(sent)] });
    const api = rpc(store, answers);
    const input = request("private", crypto.randomUUID());
    await expect(api.call(input)).rejects.toThrow("runner_unavailable");
    expect(store.record("interaction", "private")?.state).toBe("pending");
    const leases = new CellLeases(store);
    leases.heartbeat("runner", [lease.leaseId], identity(), Date.now(), "test");
    await api.call(input);
    expect(sent).toHaveLength(1);
    leases.heartbeat("runner", [], identity(), Date.now(), "test");
    question(store, "second-private", true);
    await expect(api.call(request("second-private", crypto.randomUUID()))).rejects.toThrow(
      "runner_unavailable",
    );
    expect(store.record("interaction", "second-private")?.state).toBe("pending");
  });
});
