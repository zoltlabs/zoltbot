import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { InteractionSchema, parse } from "@zoltbot/protocol";
import { Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CloudRpc } from "../src/cloud-rpc.js";
import { CellLeases } from "../src/leases.js";
import { CellMacRecords } from "../src/mac-records.js";
import { runnerEvent } from "../src/runner-events.js";
import { CellService } from "../src/service.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import { caps } from "./capabilities.js";
import { sandboxFixture } from "./sandbox-fixture.js";

it("retains a Mac approval across object eviction and worker session replacement", async () => {
  const cell = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  const now = Date.now();
  const worker: CellTokenClaims = {
    iss: env.CELL_JWT_ISSUER,
    aud: "cell",
    org: "org",
    sub: "member",
    device: "worker",
    surface: "runner",
    kind: "sandbox_runner",
    task: "task",
    jti: "fixture",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 600,
  };
  const request = {
    requestId: "request",
    taskId: "task",
    turnId: "turn",
    userId: "member",
    targetDeviceId: "mac",
    command: "uname",
    cwd: "/home/user/work",
  };
  const pending = await runInDurableObject(cell, async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const records = new CellMacRecords(store, { orgId: "org", userId: "member" });
    const leases = new CellLeases(store),
      lease = leases.assign("task", "worker", worker);
    leases.heartbeat("worker", [lease.leaseId], worker, now, "connection");
    store.database
      .prepare("INSERT INTO cell_runner_connections VALUES(?,?)")
      .run("worker", "connection");
    runnerEvent(store, worker, "worker", {
      taskId: "task",
      leaseId: lease.leaseId,
      sessionId: "old",
      runnerSeq: 1,
      event: {
        t: "session.ready",
        nativeId: "native",
        capabilities: caps,
        providerVersion: "fixture",
      },
    });
    runnerEvent(store, worker, "worker", {
      taskId: "task",
      leaseId: lease.leaseId,
      sessionId: "old",
      runnerSeq: 2,
      event: { t: "turn.started", turnId: "turn" },
    });
    const progress = await records.request(
      { claims: worker, connectionId: "connection" },
      request,
      { deviceId: "mac", mac: "Test Mac", cwd: request.cwd },
    );
    if (progress.state !== "pending") throw new Error("fixture_pending_missing");
    return { id: progress.interactionId, leaseId: lease.leaseId };
  });
  await evictDurableObject(cell);
  await runInDurableObject(cell, async (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    runnerEvent(store, worker, "worker", {
      taskId: "task",
      leaseId: pending.leaseId,
      sessionId: "new",
      runnerSeq: 3,
      event: {
        t: "session.ready",
        nativeId: "native",
        capabilities: caps,
        providerVersion: "fixture",
      },
    });
    const interaction = parse(InteractionSchema, store.record("interaction", pending.id));
    expect(interaction.state).toBe("pending");
    expect(store.record("turn", "turn")?.status).toBe("interrupted");
    const draft = interaction.context?.macExec;
    if (!draft) throw new Error("fixture_draft_missing");
    const client: CellTokenClaims = {
      ...worker,
      kind: "client",
      device: "phone",
      surface: "phone",
      session: "account-session",
    };
    delete client.task;
    const rpc = new CloudRpc(
      store,
      client,
      new CellService(
        {
          origin: env.ORCHESTRATOR_URL,
          issuer: env.CELL_JWT_ISSUER,
          signingKey: env.ORCHESTRATOR_SIGNING_KEY,
        },
        "org",
      ),
    );
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "interaction.answer",
      commandId: "approve",
      params: {
        id: pending.id,
        version: 1,
        answer: {
          action: "accept",
          choice: "allow_once",
          by: { kind: "human", id: "member" },
          at: new Date().toISOString(),
          signedApproval: {
            payload: { ...draft, signerDeviceId: "phone", issuedAt: now, expiresAt: now + 300000 },
            signature: "A".repeat(86),
          },
        },
      },
    };
    expect(await rpc.call(call)).toEqual(await rpc.call(call));
    expect(
      (
        store.database.prepare("SELECT count(*) AS n FROM cell_answer_deliveries").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
  await evictDurableObject(cell);
  await runInDurableObject(cell, async (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const records = new CellMacRecords(store, { orgId: "org", userId: "member" });
    expect(
      (
        await records.request({ claims: worker, connectionId: "connection" }, request, {
          deviceId: "mac",
          mac: "Test Mac",
          cwd: request.cwd,
        })
      ).state,
    ).toBe("running");
    expect(store.record("interaction", pending.id)?.state).toBe("answered");
  });
});
