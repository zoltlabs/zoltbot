import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { CellTokenVerifier } from "../../packages/cell/src/auth.js";
import { createCellIdentity } from "../../tools/fakes/src/cell-identity.js";

it("verifies ephemeral desktop, phone and runner identities through the real Cell verifier and a localhost JWKS", async () => {
  let clock = Date.now();
  const identity = await createCellIdentity({
    issuer: "https://accounts.example.invalid",
    now: () => clock,
  });
  let reads = 0;
  const server = createServer((_request, response) => {
    reads++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(identity.jwks()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const verifier = new CellTokenVerifier(
      {
        issuer: "https://accounts.example.invalid",
        jwksUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`,
      },
      fetch,
      () => clock,
    );
    const member = {
      sub: "member",
      org: "personal",
      device: "desktop",
      session: "desktop-session",
    };
    const clients = [
      { ...member, kind: "client" as const, surface: "desktop" as const },
      {
        ...member,
        device: "phone",
        session: "phone-session",
        kind: "client" as const,
        surface: "phone" as const,
      },
      { ...member, kind: "mac_runner" as const, surface: "runner" as const, grant: "grant" },
      {
        sub: "member",
        org: "personal",
        device: "sandbox",
        task: "task",
        kind: "sandbox_runner" as const,
        surface: "runner" as const,
      },
    ];
    for (const expected of clients) {
      const token = await identity.issue(expected);
      const actual = await verifier.verify(token, "personal");
      expect(actual).toMatchObject(expected);
      await expect(verifier.verify(token, "other")).rejects.toThrow("unauthorized");
    }
    expect(reads).toBe(1);
    const first = clients[0];
    if (!first) throw new Error("fixture_client_missing");
    const token = await identity.issue(first);
    clock += 601000;
    await expect(verifier.verify(token, "personal")).rejects.toThrow("unauthorized");
    expect(JSON.stringify(identity)).toBe("{}");
    const jwks = identity.jwks();
    const key = jwks.keys[0];
    if (!key) throw new Error("fixture_key_missing");
    expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
    key.kid = "changed";
    expect(identity.jwks().keys[0]?.kid === "changed").toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("refuses malformed fixture authority and JWTs signed by a different ephemeral issuer key", async () => {
  const issuer = "https://accounts.example.invalid";
  for (const origin of [
    "http://accounts.example.invalid",
    "https://accounts.example.invalid/path",
    "https://member:password@example.invalid",
  ])
    await expect(createCellIdentity({ issuer: origin })).rejects.toThrow(
      "fixture_identity_invalid",
    );
  const identity = await createCellIdentity({ issuer }),
    other = await createCellIdentity({ issuer });
  const client = {
    sub: "member",
    org: "org",
    device: "device",
    kind: "client" as const,
    surface: "desktop" as const,
    session: "session",
  };
  for (const input of [
    {
      sub: client.sub,
      org: client.org,
      device: client.device,
      kind: client.kind,
      surface: client.surface,
    },
    { ...client, surface: "runner" as const },
    { ...client, grant: "forbidden" },
    { ...client, kind: "mac_runner" as const, surface: "runner" as const },
    { ...client, kind: "sandbox_runner" as const, surface: "runner" as const, task: "task" },
  ])
    await expect(identity.issue(input)).rejects.toThrow();
  await expect(identity.issue(client, 601)).rejects.toThrow("fixture_identity_invalid");
  const verifier = new CellTokenVerifier(
    { issuer, jwksUrl: "https://keys.example.invalid" },
    async () => Response.json(identity.jwks()),
  );
  await expect(verifier.verify(await other.issue(client), "org")).rejects.toThrow("unauthorized");
});
