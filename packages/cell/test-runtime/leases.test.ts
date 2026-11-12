import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { createTask, handle } from "@zoltbot/core";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CellLeases } from "../src/leases.js";
import { seedCell } from "../src/seed.js";
import { CellSqlDriver } from "../src/sql-driver.js";

it("fences one writer, commits runner sequence with receipts, and wakes an offline sandbox once", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  const claims: CellTokenClaims = {
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
  await runInDurableObject(stub, (_instance, state) => {
    const driver = new CellSqlDriver(state.storage);
    migrateDriver(driver);
    const store = new Store(driver);
    seedCell(store);
    const context = {
      commandId: "project",
      at: "2026-11-11T00:00:00Z",
      actor: { kind: "human" as const, id: "member" },
    };
    store.dispatch(
      "project",
      (snapshot) =>
        handle(
          snapshot,
          {
            type: "create",
            kind: "project",
            value: {
              id: "project",
              name: "Test",
              goal: "",
              instructions: "",
              constraints: "",
              roots: [],
              hierarchyDepth: 0,
              tags: [],
              requireCodeReview: false,
              skipFinalGateWhenReviewed: false,
              archived: false,
              createdAt: context.at,
            },
          },
          context,
        ),
      { scope: { projectId: "project" } },
    );
    store.dispatch(
      "task",
      (snapshot) => {
        const outcome = createTask(
          {
            ...snapshot,
            agent: [store.record("agent", "cloud-claude") as Record<string, unknown>],
          },
          {
            id: "task",
            title: "Test",
            brief: "Test",
            profileId: "cloud-claude",
            node: { type: "project", id: "project" },
          },
          { ...context, commandId: "task" },
        );
        return {
          ...outcome,
          events: outcome.events.map((event) =>
            event.aggregateType === "task"
              ? { ...event, payload: { ...(event.payload as object), location: "sandbox" } }
              : event,
          ),
        };
      },
      { scope: { projectId: "project" } },
    );
    const leases = new CellLeases(store);
    const lease = leases.assign("task", "runner", claims, 0);
    expect(() => leases.assign("task", "other", { ...claims, device: "other" }, 0)).toThrow(
      "runner_lease_conflict",
    );
    expect(() =>
      leases.require("task", lease.leaseId, "other", { ...claims, device: "other" }),
    ).toThrow("forbidden");
    const dispatch = () =>
      store.dispatch(
        "runner:task:1",
        () => {
          leases.acknowledge(lease, 1);
          return { events: [], result: { ack: 1 } };
        },
        { scope: { taskId: "task" } },
      );
    expect(() =>
      store.dispatch(
        "runner:task:1",
        () => {
          leases.acknowledge(lease, 1);
          return { events: [], result: { ack: 1 } };
        },
        { scope: { taskId: "task" }, killPoint: "after_events" },
      ),
    ).toThrow("kill point");
    expect(leases.get("task")?.lastSeq).toBe(0);
    expect(dispatch()).toEqual(dispatch());
    expect(leases.get("task")?.lastSeq).toBe(1);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    const leases = new CellLeases(new Store(new CellSqlDriver(state.storage)));
    expect(leases.get("task")?.lastSeq).toBe(1);
    const requests: string[] = [];
    const wake = async (taskId: string) => {
      requests.push(taskId);
    };
    expect(leases.offline("task", 59999)).toBe(false);
    expect(leases.offline("task", 60000)).toBe(true);
    await leases.checkPresence(wake, 60000);
    await leases.checkPresence(wake, 90000);
    expect(requests).toEqual(["task"]);
    const lease = leases.get("task");
    if (!lease) throw new Error("lease_missing");
    leases.heartbeat("runner", [lease.leaseId], claims, 100000);
    expect(leases.offline("task", 100000)).toBe(false);
    await leases.checkPresence(wake, 160000, () => true);
    expect(requests).toEqual(["task"]);
    await leases.checkPresence(wake, 160000);
    expect(requests).toEqual(["task", "task"]);
    leases.heartbeat("runner", [lease.leaseId], claims, 220000);
    const ids: string[] = [];
    expect(
      await leases.checkPresence(async (_task, id) => {
        ids.push(id);
        throw new Error("orchestrator_unavailable");
      }, 280000),
    ).toBe(true);
    expect(
      await leases.checkPresence(async (_task, id) => {
        ids.push(id);
      }, 281000),
    ).toBe(false);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(leases.get("task")?.wakePending).toBe(false);
  });
});
