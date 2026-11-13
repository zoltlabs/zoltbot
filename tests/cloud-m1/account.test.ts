import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { CellTokenVerifier } from "../../packages/cell/src/auth.js";
import { serviceToken } from "../../packages/cell/src/service.js";
import { createCloudFake } from "../../tools/fakes/src/cloud.js";
import { createCloudM1Account } from "../../tools/fakes/src/cloud-m1-account.js";

const paths = {
  devices: "/api/cloud/devices",
  cell: "/api/cloud/cell-token",
  runner: "/api/cloud/runner-token",
  grants: "/api/cloud/runner-grants",
  jwks: "/api/cloud/jwks.json",
};
async function device() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const bytes = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: bytes.toString("base64url"),
    deviceId: createHash("sha256").update(bytes).digest("base64url").slice(0, 22),
  };
}
it("uses localhost account HTTP to issue org-bound client and granted runner tokens with independent phone sessions", async () => {
  const serviceKey = randomBytes(32).toString("base64url"),
    issuer = "https://accounts.example.invalid";
  const account = await createCloudM1Account({
    issuer,
    cellUrl: "https://cell.example.invalid",
    serviceKey,
  });
  const desktop = await device(),
    phone = await device(),
    outsider = await device();
  const owner = account.nativeSession({
    userId: "member",
    orgId: "personal",
    surface: "desktop",
    deviceId: desktop.deviceId,
  });
  const mobile = account.nativeSession({
    userId: "member",
    orgId: "personal",
    surface: "phone",
    deviceId: phone.deviceId,
  });
  const other = account.nativeSession({
    userId: "other",
    orgId: "other-org",
    surface: "desktop",
    deviceId: outsider.deviceId,
  });
  const server = createCloudFake({ cloud: account.handle });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    path: string,
    bearer: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    for (const [session, key] of [
      [owner, desktop],
      [mobile, phone],
      [other, outsider],
    ] as const)
      expect((await call(paths.devices, session.accessToken, key)).status).toBe(200);
    expect(
      (
        await call(paths.cell, other.accessToken, {
          orgId: "personal",
          deviceId: outsider.deviceId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(paths.cell, owner.accessToken, { orgId: "personal", deviceId: phone.deviceId }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(paths.runner, owner.accessToken, {
          orgId: "personal",
          deviceId: desktop.deviceId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          paths.grants,
          mobile.accessToken,
          { deviceId: phone.deviceId, canRunTasks: true, canMacExec: true },
          "PUT",
        )
      ).status,
    ).toBe(403);
    const enrolled = await call(
      paths.grants,
      owner.accessToken,
      { deviceId: desktop.deviceId, canRunTasks: true, canMacExec: true },
      "PUT",
    );
    expect(enrolled.status).toBe(200);
    const grant = (await enrolled.json()).grant;
    const verifier = new CellTokenVerifier({ issuer, jwksUrl: `${origin}${paths.jwks}` });
    for (const [session, key, path, surface, kind] of [
      [owner, desktop, paths.cell, "desktop", "client"],
      [mobile, phone, paths.cell, "phone", "client"],
      [owner, desktop, paths.runner, "runner", "mac_runner"],
    ] as const) {
      const response = await call(path, session.accessToken, {
        orgId: "personal",
        deviceId: key.deviceId,
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      if (typeof result.token !== "string") throw new Error("fixture_token_missing");
      const claims = await verifier.verify(result.token, "personal");
      expect(claims).toMatchObject({
        sub: "member",
        device: key.deviceId,
        surface,
        kind,
        session: session.sessionId,
      });
    }
    const auth = await serviceToken(serviceKey, issuer, "orchestrator", "personal");
    const accessPath = new URL("/api/cloud/access", origin);
    const access = async (changes = {}) =>
      (
        await fetch(accessPath, {
          method: "POST",
          headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
          body: JSON.stringify({
            orgId: "personal",
            userId: "member",
            deviceId: desktop.deviceId,
            sessionId: owner.sessionId,
            surface: "runner",
            kind: "mac_runner",
            grantId: grant.id,
            tokenId: "token",
            ...changes,
          }),
        })
      ).json();
    expect((await access()).active).toBe(true);
    const cellAccess = await fetch(accessPath, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ orgId: "personal", userId: "member", kind: "cell" }),
    });
    expect((await cellAccess.json()).active).toBe(true);
    expect((await access({ orgId: "other-org" })).active === true).toBe(false);
    const listed = await (await call(paths.devices, other.accessToken)).json();
    expect(listed.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([
      outsider.deviceId,
    ]);
    expect(
      (await call(`${paths.devices}/${phone.deviceId}`, owner.accessToken, undefined, "DELETE"))
        .status,
    ).toBe(200);
    expect(
      (await call(paths.cell, mobile.accessToken, { orgId: "personal", deviceId: phone.deviceId }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          paths.grants,
          owner.accessToken,
          { deviceId: desktop.deviceId, canRunTasks: false, canMacExec: false },
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect((await access()).active).toBe(false);
    expect(
      (
        await call(paths.runner, owner.accessToken, {
          orgId: "personal",
          deviceId: desktop.deviceId,
        })
      ).status,
    ).toBe(403);
  } finally {
    account.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("keeps fixture secrets write-only, rotates native sessions and enforces the beta gate", async () => {
  const account = await createCloudM1Account({
    issuer: "https://accounts.example.invalid",
    cellUrl: "https://cell.example.invalid",
    serviceKey: randomBytes(32).toString("base64url"),
  });
  const key = await device();
  const owner = account.nativeSession({
    userId: "member",
    orgId: "personal",
    deviceId: key.deviceId,
    surface: "desktop",
  });
  const blocked = account.nativeSession({
    userId: "blocked",
    orgId: "blocked-org",
    deviceId: key.deviceId,
    surface: "desktop",
    beta: false,
  });
  const server = createCloudFake({ cloud: account.handle });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const secretPath = new URL("/api/cloud/secrets/github", origin);
  try {
    const standIn = randomBytes(32).toString("base64url");
    const write = async (bearer: string) =>
      fetch(secretPath, {
        method: "PUT",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ value: standIn }),
      });
    expect((await write(blocked.accessToken)).status).toBe(403);
    const saved = await write(owner.accessToken);
    expect(saved.status).toBe(200);
    expect((await saved.text()).includes(standIn)).toBe(false);
    const providerKey = randomBytes(32).toString("base64url");
    const providerWrite = await fetch(new URL("/api/cloud/secrets/anthropic", origin), {
      method: "PUT",
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ value: providerKey }),
    });
    expect(providerWrite.status).toBe(200);
    const injected = account.secretsForTask(
      { orgId: "personal", userId: "member", taskId: "task" },
      "claude",
    );
    expect(injected.providerKey === providerKey && injected.githubToken === standIn).toBe(true);
    expect(() =>
      account.secretsForTask({ orgId: "other", userId: "member", taskId: "task" }, "claude"),
    ).toThrow("fixture_secret_required");
    const read = await fetch(secretPath, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(read.status).toBe(404);
    expect((await read.text()).includes(standIn)).toBe(false);
    const rotate = () =>
      fetch(`${origin}/api/account/session/refresh`, {
        method: "POST",
        headers: { authorization: `Refresh ${owner.refreshToken}` },
      });
    const first = await rotate();
    expect(first.status).toBe(200);
    const next = await first.json();
    expect(next.sessionId).toBe(owner.sessionId);
    expect(typeof next.accessToken === "string" && next.accessToken !== owner.accessToken).toBe(
      true,
    );
    expect((await rotate()).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/account/me`, {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/account/me`, {
          headers: { authorization: `Bearer ${next.accessToken}` },
        })
      ).status,
    ).toBe(200);
    expect(JSON.stringify(account)).toBe("{}");
    account.clear();
    expect(
      (
        await fetch(`${origin}/api/account/me`, {
          headers: { authorization: `Bearer ${next.accessToken}` },
        })
      ).status,
    ).toBe(401);
  } finally {
    account.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
