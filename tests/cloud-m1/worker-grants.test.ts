import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { CellTokenVerifier } from "../../packages/cell/src/auth.js";
import { serviceToken } from "../../packages/cell/src/service.js";
import { createCloudFake } from "../../tools/fakes/src/cloud.js";
import { createCloudM1Account } from "../../tools/fakes/src/cloud-m1-account.js";
import { createCloudM1Workers } from "../../tools/fakes/src/cloud-m1-workers.js";

it("issues and refreshes task-bound sandbox authority through real localhost JWKS and refuses revoked or cross-task capabilities", async () => {
  const issuer = "https://accounts.example.invalid",
    cellUrl = "https://cell.example.invalid",
    serviceKey = randomBytes(32).toString("base64url");
  const account = await createCloudM1Account({ issuer, cellUrl, serviceKey });
  const workers = await createCloudM1Workers({ issuer, cellUrl, serviceKey, account });
  const server = createCloudFake({ cloud: workers.handle });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scope = { orgId: "personal", userId: "member", taskId: "task", runnerId: "sandbox-runner" };
  try {
    const initial = await workers.provision(scope);
    const verifier = new CellTokenVerifier({
      issuer,
      jwksUrl: new URL("/api/cloud/jwks.json", origin).href,
    });
    const first = await verifier.verify(initial.token, "personal");
    expect(first).toMatchObject({
      kind: "sandbox_runner",
      sub: "member",
      org: "personal",
      task: "task",
      device: scope.runnerId,
      surface: "runner",
    });
    expect(first.session).toBeUndefined();
    expect(first.grant).toBeUndefined();
    expect(Date.parse(initial.expiresAt)).toBe(first.exp * 1000);
    const refresh = (
      body = { orgId: scope.orgId, taskId: scope.taskId, runnerId: scope.runnerId },
      capability = initial.refresh,
    ) =>
      fetch(new URL("/api/cloud/worker-token", origin), {
        method: "POST",
        headers: { authorization: `Worker ${capability}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const renewed = await refresh();
    expect(renewed.status).toBe(200);
    const result = await renewed.json();
    if (typeof result.token !== "string") throw new Error("fixture_token_missing");
    const next = await verifier.verify(result.token, "personal");
    expect(Date.parse(result.expiresAt)).toBe(next.exp * 1000);
    expect(
      (await refresh({ orgId: "other", taskId: "task", runnerId: scope.runnerId })).status,
    ).toBe(403);
    expect(
      (await refresh({ orgId: "personal", taskId: "different", runnerId: scope.runnerId })).status,
    ).toBe(403);
    expect((await refresh(undefined, randomBytes(32).toString("base64url"))).status).toBe(403);
    const auth = await serviceToken(serviceKey, issuer, "orchestrator", "personal");
    const access = async (changes = {}) =>
      (
        await fetch(new URL("/api/cloud/access", origin), {
          method: "POST",
          headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
          body: JSON.stringify({
            orgId: "personal",
            userId: "member",
            deviceId: scope.runnerId,
            taskId: "task",
            kind: "sandbox_runner",
            surface: "runner",
            tokenId: first.jti,
            ...changes,
          }),
        })
      ).json();
    expect((await access()).active).toBe(true);
    expect((await access({ deviceId: "different" })).active).toBe(false);
    expect((await access({ userId: "different" })).active).toBe(false);
    workers.revoke("personal", "task");
    expect((await access()).active).toBe(false);
    expect((await refresh()).status).toBe(403);
    expect(JSON.stringify(workers)).toBe("{}");
    workers.clearOrg("personal");
  } finally {
    account.clear();
    workers.clearOrg("personal");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
