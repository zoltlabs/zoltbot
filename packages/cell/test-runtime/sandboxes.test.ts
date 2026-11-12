import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { SandboxRecord } from "@zoltbot/cloud-contracts";
import { handle } from "@zoltbot/core";
import { Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CellSandboxes } from "../src/sandboxes.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import { epoch, sandboxFixture } from "./sandbox-fixture.js";

function record(state: SandboxRecord["state"] = "running"): SandboxRecord {
  return {
    orgId: "org",
    userId: "member",
    taskId: "task",
    sandboxId: "sandbox",
    target: "e2b",
    state,
    sleepKeepsProcesses: false,
    createdAt: new Date(epoch).toISOString(),
    updatedAt: new Date(epoch).toISOString(),
  };
}
function saved(store: Store, value = record()) {
  store.database
    .prepare("INSERT INTO cell_sandboxes VALUES(?,?)")
    .run("task", JSON.stringify(value));
}
function stub() {
  return env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
}

it("retries an uncertain create and wake with their original operation IDs after eviction", async () => {
  const cell = stub();
  const createId = await runInDurableObject(cell, async (_instance, state) => {
    const store = sandboxFixture(state.storage);
    const requests: string[] = [];
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async (_path, _method, _body, options) => {
          if (!options?.operationId) throw new Error("operation_id_missing");
          requests.push(options.operationId);
          throw new Error("unavailable");
        },
      },
      "org",
      "member",
      () => epoch,
    );
    expect(await sandboxes.ensure("task")).toBeUndefined();
    expect(await sandboxes.ensure("task")).toBeUndefined();
    expect(requests[0]).toBe(requests[1]);
    expect(store.record("task", "task")?.holdReason).toBe("orchestrator_unavailable");
    return requests[0];
  });
  await evictDurableObject(cell);
  await runInDurableObject(cell, async (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const requests: { path: string; id: string | undefined }[] = [];
    let fail = false;
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async (path, _method, _body, options) => {
          requests.push({ path, id: options?.operationId });
          if (fail) throw new Error("unavailable");
          return record();
        },
      },
      "org",
      "member",
      () => epoch,
    );
    expect((await sandboxes.ensure("task"))?.state).toBe("running");
    expect(requests[0]?.id).toBe(createId);
    expect(store.record("task", "task")?.holdReason).toBeUndefined();
    fail = true;
    await expect(sandboxes.wake("task", "wake:lease:0")).rejects.toThrow(
      "orchestrator_unavailable",
    );
    fail = false;
    await sandboxes.wake("task", "wake:lease:0");
    await sandboxes.wake("task", "wake:lease:0");
    expect(requests.slice(1)).toEqual([
      { path: "sandboxes/wake", id: "wake:lease:0" },
      { path: "sandboxes/wake", id: "wake:lease:0" },
    ]);
  });
});

it("keeps quota failures visible, rejects other org results and never marks a missing sandbox awake", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage);
    let quota = true;
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async () => {
          if (quota) throw new Error("limit_reached");
          return { ...record(), orgId: "other" };
        },
      },
      "org",
      "member",
      () => epoch,
    );
    expect(await sandboxes.ensure("task")).toBeUndefined();
    expect(store.record("task", "task")?.holdReason).toBe("limit_reached");
    quota = false;
    expect(await sandboxes.ensure("task")).toBeUndefined();
    expect(sandboxes.get("task")).toBeUndefined();
    await expect(sandboxes.wake("task")).rejects.toThrow("sandbox_unavailable");
  });
});

it("sleeps an idle task after twenty minutes and retries a failed retained-sandbox destroy", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    let now = epoch + 1200000 - 1;
    const paths: string[] = [];
    let failed = false;
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async (path, method) => {
          paths.push(`${method} ${path}`);
          if (failed) throw new Error("unavailable");
          return record(method === "DELETE" ? "destroyed" : "sleeping");
        },
      },
      "org",
      "member",
      () => now,
    );
    saved(store);
    expect(
      await sandboxes.tick(async () => {
        throw new Error("unexpected_checkpoint");
      }),
    ).toBe(epoch + 1200000);
    expect(paths).toEqual([]);
    now++;
    await sandboxes.tick(async () => {
      throw new Error("unexpected_checkpoint");
    });
    expect(paths).toEqual(["POST sandboxes/sleep"]);
    store.dispatch(
      "cancel",
      (snapshot) =>
        handle(
          snapshot,
          {
            type: "transition",
            kind: "task",
            id: "task",
            revision: 1,
            to: "cancelled",
          },
          {
            commandId: "cancel",
            at: new Date(now).toISOString(),
            actor: { kind: "human", id: "member" },
          },
        ),
      { scope: { taskId: "task" }, kinds: ["task"] },
    );
    now += 86400000;
    failed = true;
    expect(await sandboxes.tick(async () => {})).toBe(now + 15000);
    failed = false;
    await sandboxes.tick(async () => {});
    expect(sandboxes.get("task")?.state).toBe("destroyed");
    expect(paths.filter((path) => path === "DELETE sandboxes")).toHaveLength(2);
  });
});

it("does not restore storage after deletion while a create request is in flight", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage);
    let active = true;
    let release!: (value: SandboxRecord) => void;
    const response = new Promise<SandboxRecord>((resolve) => {
      release = resolve;
    });
    const sandboxes = new CellSandboxes(
      store,
      { request: () => response },
      "org",
      "member",
      () => epoch,
      () => active,
    );
    const pending = sandboxes.ensure("task");
    active = false;
    await state.storage.deleteAll();
    release(record());
    await expect(pending).rejects.toThrow("unauthorized");
    expect(
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray(),
    ).toEqual([]);
  });
});

it("checks each retained sandbox in bounded pages and keeps the earliest future alarm", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async () => {
          throw new Error("unexpected_network");
        },
      },
      "org",
      "member",
      () => epoch + 1000,
    );
    saved(store);
    for (let index = 0; index < 10; index++) {
      const id = `task-${index}`;
      sandboxFixture(state.storage, true, id);
      store.database
        .prepare("INSERT INTO cell_sandboxes VALUES(?,?)")
        .run(id, JSON.stringify({ ...record(), taskId: id }));
    }
    expect(await sandboxes.tick(async () => {})).toBe(epoch + 1001);
    expect(await sandboxes.tick(async () => {})).toBe(epoch + 1200000);
    expect(store.database.prepare("SELECT cursor FROM cell_sandbox_maintenance").all()).toEqual([]);
  });
});

it("requests a checkpoint instead of pausing an active model turn at its lifetime boundary", async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const thread = String(store.record("task", "task")?.threadId);
    // These rows only supply the lifecycle query's active-turn metadata.
    store.database
      .prepare(
        "INSERT INTO sessions(id,thread_id,provider,cwd,state,capabilities,started_at) VALUES(?,?,'claude','.','running','{}',?)",
      )
      .run("session", thread, new Date(epoch).toISOString());
    store.database
      .prepare(
        "INSERT INTO turns(id,thread_id,session_id,status,origin,started_at) VALUES(?,?,'session','running','system',?)",
      )
      .run("turn", thread, new Date(epoch).toISOString());
    const now = epoch + 1000;
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async () => {
          throw new Error("must_not_pause_an_active_model_request");
        },
      },
      "org",
      "member",
      () => now,
    );
    saved(store, { ...record(), expiresAt: new Date(now + 60000).toISOString() });
    const checkpoints: string[] = [];
    expect(
      await sandboxes.tick(async (taskId) => {
        checkpoints.push(taskId);
      }),
    ).toBe(now + 15000);
    expect(checkpoints).toEqual(["task"]);
    expect(sandboxes.get("task")?.state).toBe("running");
  });
});

it.each([
  false,
  true,
])("resumes a checkpointed task after a lifetime rollover (uncertain sleep: %s)", async (uncertain) => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const store = sandboxFixture(state.storage, true);
    const before = store.database.prepare("SELECT max(seq) AS seq FROM item_records").get() as {
      seq: number;
    };
    const now = epoch + 1000;
    const paths: string[] = [];
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async (path) => {
          paths.push(path);
          if (uncertain && paths.length === 1) throw new Error("unavailable");
          return {
            ...record(path === "sandboxes/sleep" ? "sleeping" : "running"),
            expiresAt: new Date(now + 3600000).toISOString(),
          };
        },
      },
      "org",
      "member",
      () => now,
    );
    saved(store, { ...record(), expiresAt: new Date(now + 60000).toISOString() });
    sandboxes.checkpoint("task");
    await sandboxes.tick(async () => {
      throw new Error("unexpected_checkpoint");
    });
    if (uncertain) await sandboxes.tick(async () => {});
    expect(paths).toEqual(
      uncertain
        ? ["sandboxes/sleep", "sandboxes/sleep", "sandboxes/wake"]
        : ["sandboxes/sleep", "sandboxes/wake"],
    );
    expect(store.record("task", "task")?.state).toBe("running");
    const after = store.database.prepare("SELECT max(seq) AS seq FROM item_records").get() as {
      seq: number;
    };
    expect(after.seq).toBe(before.seq + 1);
  });
});
