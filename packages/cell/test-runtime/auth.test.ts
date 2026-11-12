import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { requestInteraction } from "@zoltbot/core";
import { methodCatalog } from "@zoltbot/protocol";
import { Store } from "@zoltbot/store/portable";
import { afterEach, expect, it, vi } from "vitest";
import { CellLeases } from "../src/leases.js";
import { serviceToken } from "../src/service.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import worker from "../src/worker.js";
import { signer } from "./identity.js";

afterEach(() => vi.restoreAllMocks());
async function call(path: string, method: string, token?: string, body?: unknown) {
  const response = await worker.fetch(
    new Request(`https://cell.example.invalid${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  );
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}
it("refuses every cloud method before forwarding a token for another org", async () => {
  const id = await signer();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ keys: [id.jwk] }));
  const token = await id.token("owned");
  for (const [method, contract] of Object.entries(methodCatalog)) {
    if (contract.where === "local") continue;
    const response = await call("/v1/orgs/other/rpc", "POST", token, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {},
    });
    expect(response.status, method).toBe(401);
    expect(await response.text()).toBe("");
  }
  expect((await call("/v1/orgs/owned/connect", "GET")).status).toBe(401);
  expect((await call("/v1/orgs/owned/unknown", "GET", token)).status).toBe(404);
});
it("opens only after the active membership check and deletes storage only with a service token", async () => {
  const id = await signer();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url) === env.CELL_JWKS_URL) return Response.json({ keys: [id.jwk] });
    if (String(url).endsWith("/access")) return Response.json({ active: true });
    throw new Error("unexpected_network");
  });
  const pendingOrg = crypto.randomUUID();
  let release: ((response: Response) => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
    if (String(url) === env.CELL_JWKS_URL) return Response.json({ keys: [id.jwk] });
    entered?.();
    return pending;
  });
  const stale = call(`/v1/orgs/${pendingOrg}/rpc`, "POST", await id.token(pendingOrg), {});
  await started;
  const deletion = await serviceToken(
    env.ORCHESTRATOR_SIGNING_KEY,
    env.CELL_JWT_ISSUER,
    "cell-service",
    pendingOrg,
  );
  expect((await call(`/v1/orgs/${pendingOrg}`, "DELETE", deletion)).status).toBe(200);
  release?.(Response.json({ active: true }));
  expect((await stale).status).toBe(401);
  const pendingStub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(pendingOrg));
  expect(
    await runInDurableObject(pendingStub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_identity'")
        .toArray(),
    ),
  ).toEqual([]);
  vi.mocked(globalThis.fetch).mockImplementation(async (url) =>
    String(url) === env.CELL_JWKS_URL
      ? Response.json({ keys: [id.jwk] })
      : Response.json({ active: true }),
  );
  const org = crypto.randomUUID();
  const token = await id.token(org);
  const rpc = async (
    method: string,
    params: unknown,
    commandId = crypto.randomUUID(),
    orgId = org,
  ) => {
    const response = await call(`/v1/orgs/${orgId}/rpc`, "POST", await id.token(orgId), {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
      commandId,
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      result?: Record<string, unknown>;
      error?: { message: string };
    }>;
  };
  expect((await rpc("hello", { protocolVersion: 1, token: "unused" })).result?.version).toBe(
    "0.1.0",
  );
  const projectParams = {
    name: "Repository",
    repository: "example/repository",
    defaultBranch: "main",
    setupScript: "",
  };
  const commandId = crypto.randomUUID();
  const project = await rpc("cloud.project.create", projectParams, commandId);
  expect(project.error).toBeUndefined();
  expect((await rpc("cloud.project.create", projectParams, commandId)).result).toEqual(
    project.result,
  );
  expect(
    (await rpc("cloud.project.create", { ...projectParams, name: "Changed" }, commandId)).error
      ?.message,
  ).toBe("command_conflict");
  const projectId = String(project.result?.id);
  const task = await rpc("task.create", {
    title: "First task",
    brief: "Inspect the repository",
    profileId: "cloud-claude",
    node: { type: "project", id: projectId },
    location: "sandbox",
  });
  expect(task.error).toBeUndefined();
  expect(task.result?.location).toBe("sandbox");
  const listed = await rpc("task.list", { projectId });
  expect((listed.result?.items as { id: string }[]).map((task) => task.id)).toEqual([
    task.result?.id,
  ]);
  const memberStub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(org));
  const taskId = String(task.result?.id);
  await runInDurableObject(memberStub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const commandId = "question:create";
    store.dispatch(
      commandId,
      (snapshot) =>
        requestInteraction(
          snapshot,
          {
            id: "question",
            agentId: "cloud-claude",
            threadId: String(task.result?.threadId),
            taskId,
            type: "question",
            items: [
              { id: "answer", prompt: "Enter a private answer", allowOther: true, secret: true },
            ],
            chain: [],
            urgency: "blocking",
          },
          "question:item",
          { commandId, at: "2026-11-11T00:00:00Z", actor: { kind: "system", id: "cell" } },
        ),
      { scope: { taskId } },
    );
  });
  const privateAnswer = crypto.randomUUID();
  await runInDurableObject(memberStub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    const seconds = Math.floor(Date.now() / 1000);
    const claims: CellTokenClaims = {
      iss: env.CELL_JWT_ISSUER,
      aud: "cell",
      org,
      sub: "member",
      device: "runner",
      kind: "sandbox_runner",
      surface: "runner",
      task: taskId,
      iat: seconds,
      exp: seconds + 600,
      jti: "test",
    };
    new CellLeases(store).assign(taskId, "runner", claims);
  });
  const nativeResponse = await worker.fetch(
    new Request(`https://cell.example.invalid/v1/orgs/${org}/connect`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${await id.token(org, { kind: "sandbox_runner", surface: "runner", device: "runner", task: taskId, session: undefined })}`,
      },
    }),
    env,
  );
  const native = nativeResponse.webSocket;
  if (!native) throw new Error("socket_missing");
  native.accept();
  let receivedPrivate = false;
  let hello = false;
  native.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === "private-test-hello") hello = true;
    if (message.method !== "runner.command") return;
    receivedPrivate = JSON.stringify(message.params).includes(privateAnswer);
    native.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
  });
  native.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "private-test-hello",
      method: "runner.hello",
      params: {
        kind: "sandbox",
        runnerId: "runner",
        protocolVersion: 1,
        versions: {},
        clis: [],
        sleepKeepsProcesses: false,
      },
    }),
  );
  await vi.waitFor(() => expect(hello).toBe(true));
  const answered = await rpc("interaction.answer", {
    id: "question",
    version: 1,
    answer: {
      action: "accept",
      answers: { answer: { other: privateAnswer } },
      by: { kind: "agent", id: "forged" },
      at: "2026-11-11T00:00:00Z",
    },
  });
  expect(answered.error).toBeUndefined();
  await vi.waitFor(() => expect(receivedPrivate).toBe(true));
  expect((answered.result?.resolution as { by: { kind: string; id: string } }).by).toEqual({
    kind: "human",
    id: "member",
  });
  const persisted = await runInDurableObject(memberStub, (_instance, state) => {
    const store = new Store(new CellSqlDriver(state.storage));
    return JSON.stringify({
      events: store.eventsSince(0),
      receipts: store.database.prepare("SELECT result FROM command_receipts").all(),
      deliveries: store.database.prepare("SELECT body FROM cell_answer_deliveries").all(),
    });
  });
  expect(persisted.includes(privateAnswer)).toBe(false);
  const otherOrg = crypto.randomUUID();
  expect(
    (
      await rpc(
        "task.cancel",
        { id: task.result?.id, confirmed: true },
        crypto.randomUUID(),
        otherOrg,
      )
    ).error?.message,
  ).toBe("forbidden");
  expect(
    (await rpc("task.list", { projectId }, crypto.randomUUID(), otherOrg)).error?.message,
  ).toBe("forbidden");
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(org));
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec("SELECT user_id FROM cell_identity").one().user_id,
    ),
  ).toBe("member");
  expect((await call(`/v1/orgs/${org}`, "DELETE", token)).status).toBe(401);
  const service = await serviceToken(
    env.ORCHESTRATOR_SIGNING_KEY,
    env.CELL_JWT_ISSUER,
    "cell-service",
    org,
  );
  expect((await call(`/v1/orgs/${org}`, "DELETE", service)).status).toBe(200);
  expect(
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_identity'")
        .toArray(),
    ),
  ).toEqual([]);
  expect((await call(`/v1/orgs/${org}/rpc`, "POST", token, {})).status).toBe(401);
  // The global deletion tombstone also prevents storage resurrection after eviction.
  vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
    if (String(url) === env.CELL_JWKS_URL) return Response.json({ keys: [id.jwk] });
    return Response.json({ active: false });
  });
  await evictDurableObject(stub);
  expect((await call(`/v1/orgs/${org}/rpc`, "POST", token, {})).status).toBe(401);
  expect(
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_identity'")
        .toArray(),
    ),
  ).toEqual([]);
});
