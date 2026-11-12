import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { createTask, handle, startTask } from "@zoltbot/core";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CellLeases } from "../src/leases.js";
import { runnerEvent } from "../src/runner-events.js";
import { seedCell } from "../src/seed.js";
import { CellSqlDriver } from "../src/sql-driver.js";

import { caps } from "./capabilities.js";

it("projects fenced runner observations once across a mid-turn object restart", async () => {
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
  const leaseId = await runInDurableObject(stub, (_instance, state) => {
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
    store.dispatch(
      "start",
      (snapshot) =>
        startTask(snapshot, "task", 1, {
          ...context,
          commandId: "start",
          actor: { kind: "system", id: "cell" },
        }),
      { scope: { taskId: "task" } },
    );
    return new CellLeases(store).assign("task", "runner", claims).leaseId;
  });
  const send = (seq: number, event: unknown, itemId?: string) =>
    runInDurableObject(stub, (_instance, state) =>
      runnerEvent(new Store(new CellSqlDriver(state.storage)), claims, "runner", {
        taskId: "task",
        leaseId,
        sessionId: "session",
        runnerSeq: seq,
        event,
        ...(itemId ? { itemId } : {}),
      }),
    );
  expect(
    await send(1, {
      t: "session.ready",
      nativeId: "native",
      capabilities: caps,
      providerVersion: "test",
    }),
  ).toEqual({ taskId: "task", runnerSeq: 1 });
  await send(2, { t: "turn.started", turnId: "turn" });
  await send(
    3,
    {
      t: "message.done",
      turnId: "turn",
      itemId: "provider-item",
      text: "Completed task",
      phase: "final",
    },
    "message",
  );
  await evictDurableObject(stub);
  expect(
    await send(
      3,
      {
        t: "message.done",
        turnId: "turn",
        itemId: "provider-item",
        text: "Completed task",
        phase: "final",
      },
      "message",
    ),
  ).toEqual({ taskId: "task", runnerSeq: 3 });
  await send(4, { t: "turn.done", turnId: "turn", status: "completed" });
  const result = await runInDurableObject(stub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    return {
      task: store.record("task", "task"),
      turn: store.record("turn", "turn"),
      items: store.read({ taskId: "task" }, ["item"]).item,
      receipt: store.receipt("runner:task:3"),
      count: (
        store.database
          .prepare("SELECT count(*) AS n FROM events WHERE command_id='runner:task:3'")
          .get() as { n: number }
      ).n,
    };
  });
  expect(result.task?.state).toBe("review");
  expect(result.turn?.status).toBe("completed");
  expect(result.count).toBe(1);
  expect(result.items?.filter((row) => row.id === "message")).toHaveLength(1);
  expect(
    (result.items?.find((row) => row.kind === "user")?.body as { queueState?: string }).queueState,
  ).toBe("sent");
  expect(result.receipt?.result).toEqual({ taskId: "task", runnerSeq: 3 });
  await runInDurableObject(stub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const context = {
      commandId: "changes",
      at: "2026-11-11T00:00:00Z",
      actor: { kind: "human" as const, id: "member" },
    };
    store.dispatch(
      "changes",
      (snapshot) =>
        handle(
          snapshot,
          {
            type: "review",
            id: "task",
            revision: 1,
            decision: "changes",
            feedback: "Revise the result",
          },
          context,
        ),
      { scope: { taskId: "task" } },
    );
    store.dispatch(
      "restart",
      (snapshot) =>
        startTask(snapshot, "task", 2, {
          ...context,
          commandId: "restart",
          actor: { kind: "system", id: "cell" },
        }),
      { scope: { taskId: "task" } },
    );
  });
  await send(5, { t: "turn.done", turnId: "turn", status: "completed" });
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        new Store(new CellSqlDriver(state.storage)).record("task", "task")?.state,
    ),
  ).toBe("running");
  const humanId = String(result.items?.find((row) => row.kind === "user")?.id);
  await expect(
    send(
      6,
      {
        t: "message.done",
        turnId: "turn",
        itemId: "provider-item",
        text: "Replace human input",
        phase: "final",
      },
      humanId,
    ),
  ).rejects.toThrow("forbidden");
  await expect(send(7, { t: "status", state: "ready" })).rejects.toThrow("runner_sequence_gap");
});
