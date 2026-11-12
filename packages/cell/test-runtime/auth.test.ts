import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { methodCatalog } from "@zoltbot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { base64url } from "../src/auth.js";
import { serviceToken } from "../src/service.js";
import worker from "../src/worker.js";

afterEach(() => vi.restoreAllMocks());
async function signer() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const kid = crypto.randomUUID();
  return {
    jwk: { kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid, x: exported.x, y: exported.y },
    async token(org: string) {
      const seconds = Math.floor(Date.now() / 1000);
      const input = [
        { alg: "ES256", typ: "JWT", kid },
        {
          iss: env.CELL_JWT_ISSUER,
          aud: "cell",
          sub: "member",
          device: "device",
          session: "session",
          surface: "desktop",
          kind: "client",
          org,
          iat: seconds,
          exp: seconds + 600,
          jti: crypto.randomUUID(),
        },
      ]
        .map((value) => base64url(new TextEncoder().encode(JSON.stringify(value))))
        .join(".");
      return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(input))))}`;
    },
  };
}
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
  expect((await call(`/v1/orgs/${org}/rpc`, "POST", token, {})).status).toBe(501);
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
