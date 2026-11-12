import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Store } from "@zoltbot/store/portable";
import { afterEach, expect, it, vi } from "vitest";
import { CellSandboxes } from "../src/sandboxes.js";
import { serviceToken, verifyServiceToken } from "../src/service.js";
import { CellSqlDriver } from "../src/sql-driver.js";
import worker from "../src/worker.js";
import { signer } from "./identity.js";

afterEach(() => vi.restoreAllMocks());
it("starts a queued sandbox from an authenticated HTTP request and removes its alarm on deletion", async () => {
  const identity = await signer();
  const org = crypto.randomUUID();
  const effectIds: string[] = [];
  let active = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === env.CELL_JWKS_URL) return Response.json({ keys: [identity.jwk] });
    const headers = new Headers(init?.headers);
    await verifyServiceToken(
      (headers.get("Authorization") ?? "").slice(7),
      env.ORCHESTRATOR_SIGNING_KEY,
      env.CELL_JWT_ISSUER,
      "orchestrator",
      org,
    );
    if (String(url).endsWith("/access")) return Response.json({ active });
    if (!String(url).endsWith("/sandboxes")) throw new Error("unexpected_network");
    const body = JSON.parse(String(init?.body));
    const id = headers.get("Idempotency-Key");
    if (!id) throw new Error("missing_effect_id");
    effectIds.push(id);
    const at = new Date().toISOString();
    return Response.json({
      orgId: org,
      userId: "member",
      taskId: body.taskId,
      sandboxId: "sandbox",
      target: "e2b",
      state: "running",
      sleepKeepsProcesses: false,
      createdAt: at,
      updatedAt: at,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  });
  const token = await identity.token(org);
  const rpc = async (method: string, params: unknown) => {
    const response = await worker.fetch(
      new Request(`https://cell.example.invalid/v1/orgs/${org}/rpc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          commandId: crypto.randomUUID(),
          method,
          params,
        }),
      }),
      env,
    );
    const body = (await response.json()) as { result: Record<string, unknown>; error?: unknown };
    expect(body.error).toBeUndefined();
    return body.result;
  };
  const project = await rpc("cloud.project.create", {
    name: "Repo",
    repository: "example/repository",
    defaultBranch: "main",
    setupScript: "",
  });
  const task = await rpc("task.create", {
    title: "Task",
    brief: "Inspect",
    profileId: "cloud-claude",
    node: { type: "project", id: project.id },
    location: "sandbox",
  });
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(org));
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.setAlarm(Date.now() + 3600000),
  );
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(effectIds.length).toBeGreaterThan(0);
  expect(new Set(effectIds).size).toBe(1);
  expect(
    await runInDurableObject(stub, (_instance, state) => {
      const store = new Store(new CellSqlDriver(state.storage));
      return new CellSandboxes(
        store,
        {
          request: async () => {
            throw new Error("unexpected_network");
          },
        },
        org,
        "member",
      ).get(String(task.id))?.state;
    }),
  ).toBe("running");
  const deletion = await serviceToken(
    env.ORCHESTRATOR_SIGNING_KEY,
    env.CELL_JWT_ISSUER,
    "cell-service",
    org,
  );
  const response = await worker.fetch(
    new Request(`https://cell.example.invalid/v1/orgs/${org}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${deletion}` },
    }),
    env,
  );
  expect(await response.json()).toEqual({ deleted: true });
  expect(
    await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray(),
    })),
  ).toEqual({ alarm: null, tables: [] });
  active = false;
  await evictDurableObject(stub);
  const refused = await worker.fetch(
    new Request(`https://cell.example.invalid/v1/orgs/${org}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    }),
    env,
  );
  expect(refused.status).toBe(401);
  await refused.arrayBuffer();
});
