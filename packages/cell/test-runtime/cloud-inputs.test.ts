import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { expect, it } from "vitest";
import { CloudRpc } from "../src/cloud-rpc.js";
import { CellLeases } from "../src/leases.js";
import { runnerEvent } from "../src/runner-events.js";
import { CellService } from "../src/service.js";
import { caps } from "./capabilities.js";
import { sandboxFixture } from "./sandbox-fixture.js";

function client(): CellTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: env.CELL_JWT_ISSUER,
    aud: "cell",
    org: "org",
    sub: "member",
    device: "phone",
    session: "session",
    kind: "client",
    surface: "phone",
    iat: now,
    exp: now + 600,
    jti: "test",
  };
}
function service() {
  return new CellService(
    {
      origin: env.ORCHESTRATOR_URL,
      issuer: env.CELL_JWT_ISSUER,
      signingKey: env.ORCHESTRATOR_SIGNING_KEY,
    },
    "org",
  );
}
it("queues canonical task input once, advances its item sequence and records the trusted phone actor", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const rpc = new CloudRpc(store, client(), service());
    const threadId = String(store.record("task", "task")?.threadId);
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "turn.send",
      commandId: "send",
      actor: { userId: "forged", deviceId: "forged", surface: "desktop" },
      params: {
        threadId,
        input: [{ type: "text", text: "Continue in this conversation" }],
        mode: "queue",
      },
    };
    const first = await rpc.call(request);
    expect(await rpc.call(request)).toEqual(first);
    const rows = store.database.prepare("SELECT id,seq FROM item_records ORDER BY seq").all() as {
      id: string;
      seq: number;
    }[];
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[1]?.id).toBe((first.result as { id: string }).id);
    const receipts = store.database
      .prepare("SELECT result FROM command_receipts WHERE command_id LIKE 'client:%'")
      .all() as { result: string }[];
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0]?.result ?? "null").result.actor).toEqual({
      userId: "member",
      deviceId: "phone",
      surface: "phone",
    });
    await expect(
      rpc.call({ ...request, params: { ...request.params, threadId: "other" } }),
    ).rejects.toThrow("forbidden");
    await expect(
      rpc.call({
        ...request,
        params: { ...request.params, input: [{ type: "text", text: "Changed" }] },
      }),
    ).rejects.toThrow("command_conflict");
  });
});

it("fences a human interrupt to its selected turn and stops the assigned native runner on task cancellation", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const person = client();
    const { session: _session, ...runnerPerson } = person;
    const runner: CellTokenClaims = {
      ...runnerPerson,
      kind: "sandbox_runner",
      device: "runner",
      task: "task",
      surface: "runner",
    };
    const lease = new CellLeases(store).assign("task", "runner", runner);
    for (const [runnerSeq, event] of [
      [1, { t: "session.ready", nativeId: "native", capabilities: caps, providerVersion: "fake" }],
      [2, { t: "turn.started", turnId: "turn" }],
    ] as const)
      runnerEvent(store, runner, "runner", {
        taskId: "task",
        leaseId: lease.leaseId,
        sessionId: "native-session",
        runnerSeq,
        event,
      });
    const rpc = new CloudRpc(store, person, service());
    const threadId = String(store.record("task", "task")?.threadId);
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "turn.interrupt",
      commandId: "interrupt",
      params: { threadId, turnId: "turn" },
    };
    expect((await rpc.call(request)).result).toEqual({ ok: true });
    expect((await rpc.call(request)).result).toEqual({ ok: true });
    await expect(
      rpc.call({ ...request, commandId: "another", params: { threadId, turnId: "later" } }),
    ).rejects.toThrow("interrupt_turn_changed");
    const commands = () =>
      (
        store.database.prepare("SELECT body FROM cell_runner_commands ORDER BY seq").all() as {
          body: string;
        }[]
      ).map((row) => JSON.parse(row.body));
    expect(commands()).toHaveLength(1);
    expect(commands()[0].command).toEqual({ type: "interrupt", turnId: "turn" });
    expect(commands()[0].leaseId).toBe(lease.leaseId);
    await rpc.call({
      jsonrpc: "2.0",
      id: 2,
      method: "task.cancel",
      commandId: "cancel",
      params: { id: "task", confirmed: true },
    });
    expect(store.record("task", "task")?.state).toBe("cancelled");
    expect(commands().map((row) => row.command.type)).toEqual(["interrupt", "stop"]);
    await expect(
      rpc.call({
        jsonrpc: "2.0",
        id: 3,
        method: "turn.send",
        commandId: "after-cancel",
        params: { threadId, mode: "queue", input: [{ type: "text", text: "Continue" }] },
      }),
    ).rejects.toThrow("task_not_running");
  });
});
