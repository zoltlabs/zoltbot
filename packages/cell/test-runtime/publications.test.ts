import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { handle } from "@zoltbot/core";
import { Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CloudRpc } from "../src/cloud-rpc.js";
import { CellCommands } from "../src/commands.js";
import { CellLeases } from "../src/leases.js";
import { CellPublications } from "../src/publications.js";
import { CellRunners } from "../src/runners.js";
import { CellSandboxes } from "../src/sandboxes.js";
import { CellService } from "../src/service.js";
import type { SocketAttachment } from "../src/sockets.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import { sandboxFixture } from "./sandbox-fixture.js";

const identity = (): CellTokenClaims => ({
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
  jti: "fixture",
});
const context = (commandId: string) => ({
  commandId,
  at: "2026-11-12T00:00:00Z",
  actor: { kind: "human" as const, id: "member" },
});
const head = "b".repeat(40);
function fixture(storage: DurableObjectStorage) {
  const store = sandboxFixture(storage, true);
  new CellLeases(store).assign("task", "runner", identity());
  store.dispatch(
    "require-review",
    (state) =>
      handle(
        state,
        { type: "update", kind: "task", id: "task", changes: { reviewRequired: true } },
        context("require-review"),
      ),
    { scope: { taskId: "task" } },
  );
  store.dispatch(
    "finish",
    (state) =>
      handle(
        state,
        {
          type: "submitResult",
          id: "task",
          revision: 1,
          status: "done",
          summary: "Done",
          files: [],
        },
        context("finish"),
      ),
    { scope: { taskId: "task" } },
  );
  const commands = new CellCommands(store);
  commands.enqueue("task", "diff", { type: "collect_diff", revision: 1 });
  commands.result(identity(), "runner", {
    id: "runner-command:diff",
    result: {
      taskId: "task",
      revision: 1,
      base: "a".repeat(40),
      head,
      patch: "+change",
      status: "",
      paths: ["file.ts"],
      files: [{ path: "file.ts", added: 1, removed: 0, binary: false, patch: "+change" }],
      uncommittedFiles: [],
      provenance: "Task changes",
      patchIncomplete: false,
      capturedAt: context("diff").at,
    },
  });
  return store;
}
function accept(store: Store, publications: CellPublications) {
  return store.dispatch(
    "accept",
    (state) => {
      publications.enqueue("task", 1, head, "zoltbot/task", "push");
      return handle(
        state,
        { type: "review", id: "task", revision: 1, decision: "accept" },
        context("accept"),
      );
    },
    { scope: { taskId: "task" } },
  );
}
function pushed(store: Store) {
  new CellCommands(store).result(identity(), "runner", {
    id: "runner-command:push",
    result: {
      taskId: "task",
      revision: 1,
      head,
      branch: "zoltbot/task",
      repository: "example/repository",
      pushed: true,
    },
  });
}
const response = { number: 1, url: "https://github.com/example/repository/pull/1" };
it("commits the reviewed head with acceptance, waits for push proof, and opens one PR after eviction", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage);
    let calls = 0;
    const publications = new CellPublications(
      store,
      {
        request: async () => {
          calls++;
          return response;
        },
      },
      "org",
      "member",
    );
    accept(store, publications);
    expect(await publications.tick()).toBe(true);
    expect(calls).toBe(0);
    expect(publications.get("task")?.state).toBe("pending");
    pushed(store);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    let calls = 0;
    const publications = new CellPublications(
      store,
      {
        request: async (path, method, body) => {
          calls++;
          expect([path, method, body]).toEqual([
            "github/pull-request",
            "POST",
            {
              orgId: "org",
              repository: "example/repository",
              head: "zoltbot/task",
              base: "main",
              commit: head,
              title: "Zoltbot task changes",
              body: "",
            },
          ]);
          return response;
        },
      },
      "org",
      "member",
    );
    expect(await publications.tick()).toBe(false);
    expect(await publications.tick()).toBe(false);
    expect(calls).toBe(1);
    expect(publications.get("task")).toMatchObject({
      state: "complete",
      head,
      pullRequest: response,
    });
    expect(() =>
      new CellPublications(store, { request: async () => response }, "org", "other").get("task"),
    ).toThrow("forbidden");
  });
});
it("rolls back the publication command when accepting the task fails", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => {
    const store = fixture(state.storage),
      publications = new CellPublications(
        store,
        { request: async () => response },
        "org",
        "member",
      );
    expect(() =>
      store.dispatch(
        "reject-accept",
        () => {
          publications.enqueue("task", 1, head, "zoltbot/task", "push");
          throw new Error("injected_acceptance_failure");
        },
        { scope: { taskId: "task" } },
      ),
    ).toThrow("injected_acceptance_failure");
    expect(publications.get("task")).toBeUndefined();
    expect(new CellCommands(store).published("task", "push")).toBeUndefined();
  });
});
it("refuses a different head or revision before queueing publication", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => {
    const store = fixture(state.storage),
      publications = new CellPublications(
        store,
        { request: async () => response },
        "org",
        "member",
      );
    expect(() => publications.enqueue("task", 2, head, "zoltbot/task", "push")).toThrow(
      "stale_revision",
    );
    expect(() => publications.enqueue("task", 1, "c".repeat(40), "zoltbot/task", "push")).toThrow(
      "review_changes_unavailable",
    );
    expect(publications.get("task")).toBeUndefined();
  });
});
it("retains uncertain PR work for retry and refuses malformed service replies", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage);
    let calls = 0;
    const publications = new CellPublications(
      store,
      {
        request: async () => {
          calls++;
          if (calls === 1) throw new Error("injected_lost_reply");
          if (calls === 2) return { ...response, url: "https://example.invalid" };
          return response;
        },
      },
      "org",
      "member",
    );
    accept(store, publications);
    pushed(store);
    expect(await publications.tick()).toBe(true);
    expect(publications.get("task")).toMatchObject({
      state: "pushed",
      error: "github_unavailable",
    });
    expect(await publications.tick()).toBe(true);
    expect(await publications.tick()).toBe(false);
    expect(publications.get("task")).toMatchObject({ state: "complete", pullRequest: response });
  });
});
it("does not persist a late service reply after the object is deleted", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage);
    let active = true;
    const publications = new CellPublications(
      store,
      {
        request: async () => {
          active = false;
          return response;
        },
      },
      "org",
      "member",
      () => active,
    );
    accept(store, publications);
    pushed(store);
    await publications.tick();
    expect(publications.get("task")).toMatchObject({ state: "pushed" });
    expect(publications.get("task")?.pullRequest).toBeUndefined();
  });
});

it("binds cloud acceptance to the displayed commit and replays its receipt without queueing another push", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage),
      { task: _task, ...runner } = identity();
    const client: CellTokenClaims = {
      ...runner,
      device: "phone",
      kind: "client",
      surface: "phone",
      session: "session",
    };
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
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "task.review",
      commandId: "review",
      params: { id: "task", revision: 1, decision: "accept", confirmed: true },
    };
    await expect(rpc.call(request)).rejects.toThrow("review_changes_unavailable");
    expect(store.record("task", "task")?.state).toBe("review");
    const accepted = { ...request, params: { ...request.params, reviewedCommit: head } };
    const first = await rpc.call(accepted);
    expect(await rpc.call(accepted)).toEqual(first);
    expect(store.record("task", "task")?.state).toBe("completed");
    expect(store.database.prepare("SELECT count(*) AS n FROM cell_publications").get()).toEqual({
      n: 1,
    });
    const status = await rpc.call({
      jsonrpc: "2.0",
      id: 2,
      method: "shipping.get",
      params: { id: "task" },
    });
    expect(status.result).toMatchObject({ taskId: "task", head, state: "pending" });
  });
});

it("wakes an accepted task's sleeping sandbox while its reviewed push is pending", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage),
      publications = new CellPublications(
        store,
        { request: async () => response },
        "org",
        "member",
      );
    accept(store, publications);
    const now = Date.parse(context("accept").at) + 1000,
      calls: string[] = [];
    const record = {
      sandboxId: "sandbox",
      orgId: "org",
      userId: "member",
      taskId: "task",
      target: "e2b",
      state: "sleeping",
      createdAt: context("create").at,
      updatedAt: context("sleep").at,
      sleepKeepsProcesses: false,
    };
    const sandboxes = new CellSandboxes(
      store,
      {
        request: async (path) => {
          calls.push(path);
          return { ...record, state: "running" };
        },
      },
      "org",
      "member",
      () => now,
      () => true,
      (taskId) => new CellCommands(store).reviewPending(taskId),
    );
    store.database
      .prepare("INSERT INTO cell_sandboxes(task_id,body) VALUES(?,?)")
      .run("task", JSON.stringify(record));
    await sandboxes.tick(async () => {});
    expect(calls).toEqual(["sandboxes/wake"]);
    expect(store.record("task", "task")?.state).toBe("completed");
  });
});

it("reoffers an accepted task only for pending review work after the runner reconnects", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage),
      publications = new CellPublications(
        store,
        { request: async () => response },
        "org",
        "member",
      );
    accept(store, publications);
    let saved: SocketAttachment = {
      claims: identity(),
      connectionId: "connection",
      lastSeq: 0,
      subscribed: false,
    };
    const sent: Array<{
      method?: string;
      params?: { execution?: { task: { state: string }; queuedItems: unknown[] } };
    }> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => saved,
      serializeAttachment: (value: SocketAttachment) => {
        saved = structuredClone(value);
      },
      send: (body: string) => sent.push(JSON.parse(body)),
    } as unknown as WebSocket;
    const runners = new CellRunners(state, store);
    const hello = {
      jsonrpc: "2.0",
      id: "hello",
      method: "runner.hello",
      params: {
        runnerId: "runner",
        kind: "sandbox",
        protocolVersion: 1,
        versions: {},
        clis: [{ id: "claude", version: "fixture" }],
        sleepKeepsProcesses: false,
      },
    };
    await runners.message(socket, hello);
    expect(
      sent.find((message) => message.method === "runner.lease")?.params?.execution?.task.state,
    ).toBe("completed");
    expect(
      sent.find((message) => message.method === "runner.lease")?.params?.execution?.queuedItems,
    ).toEqual([]);
    expect(sent.filter((message) => message.method === "runner.command")).toHaveLength(1);
    pushed(store);
    sent.length = 0;
    await runners.message(socket, hello);
    expect(sent.filter((message) => message.method === "runner.lease")).toHaveLength(0);
  });
});
