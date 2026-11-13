import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createIdentity, linkId, toB64 } from "../../packages/link/src/index.js";
import { createCloudFake } from "../../tools/fakes/src/cloud.js";
import { createCloudM1Account } from "../../tools/fakes/src/cloud-m1-account.js";

it("requires recent confirmation, revokes immediately and retains a failed deletion until scoped effects finish", async () => {
  let clock = Date.now(),
    attempts = 0;
  const scopes: Array<{ orgId: string; userId: string }> = [];
  const account = await createCloudM1Account({
    issuer: "https://accounts.example.invalid",
    cellUrl: "https://cell.example.invalid",
    serviceKey: randomBytes(32).toString("base64url"),
    now: () => clock,
    async deleteAccount(scope) {
      attempts++;
      scopes.push(scope);
      if (attempts === 1) throw new Error("fixture_injected_failure");
    },
  });
  const server = createCloudFake({ cloud: (request) => account.handle(request) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const key = createIdentity(),
      deviceId = linkId(key.publicKey),
      owner = account.nativeSession({
        userId: "member",
        orgId: "personal",
        deviceId,
        surface: "desktop",
      }),
      outsider = account.nativeSession({
        userId: "other",
        orgId: "another",
        deviceId: "x".repeat(22),
        surface: "desktop",
      });
    const request = (
      route: string,
      method: string,
      body?: unknown,
      accessToken = owner.accessToken,
    ) =>
      fetch(new URL(route, origin), {
        method,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect(
      (await request("/api/cloud/devices", "POST", { deviceId, publicKey: toB64(key.publicKey) }))
        .status,
    ).toBe(200);
    expect(
      (
        await request("/api/cloud/secrets/github", "PUT", {
          value: randomBytes(32).toString("base64url"),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/cloud/runner-grants", "PUT", {
          deviceId,
          canRunTasks: false,
          canMacExec: true,
        })
      ).status,
    ).toBe(200);
    expect(account.stateFor("member").grants).toBe(1);
    expect((await request("/api/account", "DELETE", { confirm: "wrong" })).status).toBe(400);
    clock += 600001;
    expect((await request("/api/account", "DELETE", { confirm: "DELETE" })).status).toBe(403);
    clock -= 600001;
    expect((await request("/api/account", "DELETE", { confirm: "DELETE" })).status).toBe(202);
    expect((await request("/api/account/me", "GET")).status).toBe(401);
    expect(account.stateFor("member").deletionPending).toBe(true);
    await expect(account.drainDeletions()).rejects.toThrow("fixture_injected_failure");
    expect(account.stateFor("member").secrets).toBe(1);
    expect(account.stateFor("member").deletionPending).toBe(true);
    expect(await account.drainDeletions()).toBe(1);
    expect(account.stateFor("member")).toEqual({
      sessions: 0,
      devices: 0,
      grants: 0,
      secrets: 0,
      deletionPending: false,
      deleted: true,
    });
    expect(await account.drainDeletions()).toBe(0);
    expect(scopes).toEqual([
      { userId: "member", orgId: "personal" },
      { userId: "member", orgId: "personal" },
    ]);
    expect((await request("/api/account/me", "GET", undefined, outsider.accessToken)).status).toBe(
      200,
    );
    expect(account.stateFor("other").sessions).toBe(1);
  } finally {
    account.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
