import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { handle } from "@zoltbot/core";
import { Store } from "@zoltbot/store/portable";
import { expect, it } from "vitest";
import { CloudRpc } from "../src/cloud-rpc.js";
import { CellCommands } from "../src/commands.js";
import { CellLeases } from "../src/leases.js";
import { CellService } from "../src/service.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import { sandboxFixture } from "./sandbox-fixture.js";

const runner = (): CellTokenClaims => ({
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
const preview = () => ({
  taskId: "task",
  revision: 1,
  fingerprint: "f".repeat(64),
  head: "b".repeat(40),
  base: "a".repeat(40),
  files: [{ path: "file.ts", hash: "c".repeat(64), mode: "100644" }],
});
const committed = () => ({
  taskId: "task",
  revision: 1,
  fingerprint: preview().fingerprint,
  head: "c".repeat(40),
  previous: preview().head,
  base: preview().base,
});
function rpc(store: Store, member = "member") {
  const { task: _task, ...identity } = runner();
  return new CloudRpc(
    store,
    {
      ...identity,
      sub: member,
      device: "phone",
      kind: "client",
      surface: "phone",
      session: "session",
    },
    new CellService(
      {
        origin: env.ORCHESTRATOR_URL,
        issuer: env.CELL_JWT_ISSUER,
        signingKey: env.ORCHESTRATOR_SIGNING_KEY,
      },
      "org",
    ),
  );
}
function fixture(storage: DurableObjectStorage) {
  const store = sandboxFixture(storage, true);
  new CellLeases(store).assign("task", "runner", runner());
  const context = (commandId: string) => ({
    commandId,
    at: "2026-11-12T00:00:00Z",
    actor: { kind: "human" as const, id: "member" },
  });
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
  return store;
}
const previewRequest = {
  jsonrpc: "2.0",
  id: "preview",
  method: "task.reviewCommitPreview",
  commandId: "preview",
  params: { id: "task" },
};
const commitRequest = {
  jsonrpc: "2.0",
  id: "commit",
  method: "task.reviewCommit",
  commandId: "commit",
  params: { id: "task", fingerprint: preview().fingerprint, confirmed: true },
};
function command(store: Store, type: string) {
  const row = store.database
    .prepare(
      "SELECT id,body FROM cell_runner_commands WHERE json_extract(body,'$.command.type')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(type) as { id: string; body: string } | undefined;
  if (!row) throw new Error("fixture_command_missing");
  return row;
}
async function savePreview(store: Store) {
  await rpc(store).call(previewRequest);
  const row = command(store, "review_preview");
  new CellCommands(store).result(runner(), "runner", {
    id: `runner-command:${row.id}`,
    result: preview(),
  });
}
it("polls a scoped preview, audits one confirmed commit, and retains its proof across eviction", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage),
      client = rpc(store),
      commands = new CellCommands(store);
    expect((await client.call(previewRequest)).result).toEqual({ state: "pending" });
    await savePreview(store);
    expect((await client.call(previewRequest)).result).toEqual(preview());
    expect((await client.call(commitRequest)).result).toEqual({ state: "pending" });
    expect((await client.call(commitRequest)).result).toEqual({ state: "pending" });
    const row = command(store, "review_commit");
    const actor = store.record("audit", `audit:client:${row.id.slice("review-commit:".length)}`);
    expect(actor).toMatchObject({
      actor: { kind: "human", id: "member" },
      action: "task.review_commit",
      detail: { deviceId: "phone", surface: "phone", revision: 1 },
    });
    expect(
      store.database
        .prepare(
          "SELECT count(*) AS n FROM cell_runner_commands WHERE json_extract(body,'$.command.type')='review_commit'",
        )
        .get(),
    ).toEqual({ n: 1 });
    for (const changed of [
      { taskId: "other" },
      { revision: 2 },
      { fingerprint: "d".repeat(64) },
      { previous: "d".repeat(40) },
      { base: "e".repeat(40) },
      { cwd: "/unexpected" },
    ])
      expect(() =>
        commands.result(runner(), "runner", {
          id: `runner-command:${row.id}`,
          result: { ...committed(), ...changed },
        }),
      ).toThrow();
    commands.result(runner(), "runner", { id: `runner-command:${row.id}`, result: committed() });
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage)),
      client = rpc(store);
    expect((await client.call(commitRequest)).result).toEqual(committed());
    await expect(
      client.call({
        ...commitRequest,
        params: { ...commitRequest.params, fingerprint: "d".repeat(64) },
      }),
    ).rejects.toThrow("command_conflict");
    await expect(rpc(store, "other").call(commitRequest)).rejects.toThrow("forbidden");
  });
});
it("requires confirmation and a current preview without persisting a custom message", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage),
      client = rpc(store);
    await expect(
      client.call({ ...commitRequest, params: { ...commitRequest.params, confirmed: false } }),
    ).rejects.toThrow("confirmation_required");
    await expect(
      client.call({
        ...commitRequest,
        params: { ...commitRequest.params, message: "Unaccepted custom metadata" },
      }),
    ).rejects.toThrow("cloud_commit_message_unavailable");
    await expect(client.call(commitRequest)).rejects.toThrow("review_preview_stale");
    expect(store.database.prepare("SELECT count(*) AS n FROM cell_runner_commands").get()).toEqual({
      n: 0,
    });
    await savePreview(store);
    store.dispatch(
      "changes",
      (state) =>
        handle(
          state,
          { type: "review", id: "task", revision: 1, decision: "changes", feedback: "Revise" },
          {
            commandId: "changes",
            at: "2026-11-12T00:00:01Z",
            actor: { kind: "human", id: "member" },
          },
        ),
      { scope: { taskId: "task" } },
    );
    await expect(client.call(commitRequest)).rejects.toThrow("task_review_required");
  });
});
it("retains only four previews while preserving completed commit receipts", async () => {
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = fixture(state.storage),
      client = rpc(store);
    await savePreview(store);
    await client.call(commitRequest);
    const row = command(store, "review_commit"),
      commands = new CellCommands(store);
    commands.result(runner(), "runner", { id: `runner-command:${row.id}`, result: committed() });
    for (let n = 0; n < 5; n++) {
      commands.enqueue("task", `refresh:${n}`, { type: "review_preview", revision: 1 });
      commands.result(runner(), "runner", { id: `runner-command:refresh:${n}`, result: preview() });
    }
    expect(
      store.database.prepare("SELECT count(*) AS n FROM cell_runner_review_previews").get(),
    ).toEqual({ n: 4 });
    expect((await client.call(commitRequest)).result).toEqual(committed());
  });
});
