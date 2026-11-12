import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { expect, it } from "vitest";
import { CellLeases } from "../src/leases.js";
import { CellRunners } from "../src/runners.js";
import type { SocketAttachment } from "../src/sockets.js";
import { caps } from "./capabilities.js";
import { sandboxFixture } from "./sandbox-fixture.js";

it("fences an old connection's in-flight events and heartbeats after a replacement hello", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const claims: CellTokenClaims = {
      iss: env.CELL_JWT_ISSUER,
      aud: "cell",
      org: "org",
      sub: "member",
      kind: "sandbox_runner",
      device: "runner",
      task: "task",
      surface: "runner",
      iat: 1,
      exp: 9999999999,
      jti: "test",
    };
    const leases = new CellLeases(store);
    const lease = leases.assign("task", "runner", claims, 0);
    const makeSocket = (connectionId: string) => {
      let data: SocketAttachment = { claims, connectionId, lastSeq: 0, subscribed: false };
      const value = {
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => data,
        serializeAttachment: (next: SocketAttachment) => {
          data = next;
        },
        send() {},
        close() {
          value.readyState = WebSocket.CLOSING;
        },
      };
      return value;
    };
    const old = makeSocket("old"),
      current = makeSocket("current");
    const ctx = { getWebSockets: () => [old, current] } as unknown as DurableObjectState;
    const runners = new CellRunners(ctx, store);
    const hello = {
      jsonrpc: "2.0",
      id: 1,
      method: "runner.hello",
      params: {
        runnerId: "runner",
        kind: "sandbox",
        protocolVersion: 1,
        versions: {},
        clis: [],
        sleepKeepsProcesses: false,
      },
    };
    await runners.message(old as unknown as WebSocket, hello);
    await runners.message(current as unknown as WebSocket, hello);
    expect(old.readyState).toBe(WebSocket.CLOSING);
    // Model a handler that began before close, retaining its old attachment.
    old.readyState = WebSocket.OPEN;
    const heartbeat = {
      jsonrpc: "2.0",
      id: 2,
      method: "runner.heartbeat",
      params: {
        runnerId: "runner",
        leaseIds: [lease.leaseId],
        at: new Date().toISOString(),
      },
    };
    await expect(runners.message(old as unknown as WebSocket, heartbeat)).rejects.toThrow(
      "forbidden",
    );
    expect(leases.get("task")?.heartbeatAt).toBe(0);
    await runners.message(current as unknown as WebSocket, heartbeat);
    expect(leases.get("task")?.heartbeatAt).toBeGreaterThan(0);
    const event = {
      jsonrpc: "2.0",
      id: 3,
      method: "runner.event",
      params: {
        taskId: "task",
        leaseId: lease.leaseId,
        runnerSeq: 1,
        sessionId: "session",
        event: {
          t: "session.ready",
          nativeId: "native",
          capabilities: caps,
          providerVersion: "fake",
        },
      },
    };
    await expect(runners.message(old as unknown as WebSocket, event)).rejects.toThrow("forbidden");
    expect(leases.get("task")?.lastSeq).toBe(0);
    await runners.message(current as unknown as WebSocket, event);
    expect(leases.get("task")?.lastSeq).toBe(1);
    old.readyState = WebSocket.CLOSING;
    await expect(runners.message(old as unknown as WebSocket, hello)).rejects.toThrow("forbidden");
  });
});
