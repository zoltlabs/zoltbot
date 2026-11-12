import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Store } from "@zoltbot/store/portable";
import { afterEach, expect, it, vi } from "vitest";
import { CellCommands } from "../src/commands.js";
import { serviceToken } from "../src/service.js";
import worker from "../src/worker.js";
import { signer } from "./identity.js";

afterEach(() => vi.restoreAllMocks());
it("prevents a captured store facade from recreating queue tables after org deletion", async () => {
  const identity = await signer();
  const org = crypto.randomUUID();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === env.CELL_JWKS_URL) return Response.json({ keys: [identity.jwk] });
    if (String(url).endsWith("/access")) return Response.json({ active: true });
    const body = JSON.parse(String(init?.body));
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
    });
  });
  const token = await identity.token(org);
  const call = (method: string, params: unknown) =>
    worker.fetch(
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
  const project = (await (
    await call("cloud.project.create", {
      name: "Repo",
      repository: "example/repository",
      defaultBranch: "main",
      setupScript: "",
    })
  ).json()) as { result: { id: string } };
  const task = (await (
    await call("task.create", {
      title: "Task",
      brief: "Inspect",
      profileId: "cloud-claude",
      node: { type: "project", id: project.result.id },
      location: "sandbox",
    })
  ).json()) as { result: { id: string } };
  expect(task.result.id).toBeDefined();
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(org));
  let facade: Store | undefined;
  await runInDurableObject(stub, (instance) => {
    facade = (instance as unknown as { store?: Store }).store;
    if (!facade) throw new Error("store_missing");
  });
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
    await runInDurableObject(stub, () => {
      if (!facade) throw new Error("store_missing");
      try {
        new CellCommands(facade);
        return "unexpected_success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown_error";
      }
    }),
  ).toBe("store_closed");
  expect(
    await runInDurableObject(stub, async (_instance, state) => ({
      tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray(),
      alarm: await state.storage.getAlarm(),
    })),
  ).toEqual({ tables: [], alarm: null });
});
