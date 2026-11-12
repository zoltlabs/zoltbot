import { expect, it, vi } from "vitest";
import { base64url, bearer, boundedJson, CellTokenVerifier } from "./auth.js";

const now = 1_800_000_000_000;
const issuer = "https://accounts.example.invalid";
async function identity(kid = crypto.randomUUID()) {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const jwk = {
    kty: "EC",
    crv: "P-256",
    use: "sig",
    alg: "ES256",
    kid,
    x: exported.x,
    y: exported.y,
  };
  return {
    jwk,
    async token(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
      const claims = {
        iss: issuer,
        aud: "cell",
        sub: "member",
        org: "org",
        device: "device",
        session: "session",
        surface: "desktop",
        kind: "client",
        iat: now / 1000,
        exp: now / 1000 + 600,
        jti: crypto.randomUUID(),
        ...changes,
      };
      const data = [
        base64url(
          new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid, typ: "JWT", ...header })),
        ),
        base64url(new TextEncoder().encode(JSON.stringify(claims))),
      ].join(".");
      return `${data}.${base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(data))))}`;
    },
  };
}
it("verifies org-bound ES256 claims and caches public JWKS for ten minutes", async () => {
  const id = await identity();
  const fetcher = vi.fn(async () => Response.json({ keys: [id.jwk] }));
  let clock = now;
  const verifier = new CellTokenVerifier(
    { issuer, jwksUrl: `${issuer}/jwks` },
    fetcher,
    () => clock,
  );
  expect((await verifier.verify(await id.token(), "org")).sub).toBe("member");
  await verifier.verify(await id.token(), "org");
  expect(fetcher).toHaveBeenCalledTimes(1);
  clock += 600_000;
  const next = await id.token({ iat: clock / 1000, exp: clock / 1000 + 600 });
  await verifier.verify(next, "org");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("refuses invalid claims, cross-org tokens, algorithm confusion, unknown keys and bad signatures without details", async () => {
  const id = await identity();
  const verifier = new CellTokenVerifier(
    { issuer, jwksUrl: `${issuer}/jwks` },
    async () => Response.json({ keys: [id.jwk] }),
    () => now,
  );
  for (const changes of [
    { org: "other" },
    { session: undefined },
    { iss: "https://other.example.invalid" },
    { aud: "orchestrator" },
    { exp: now / 1000 },
    { iat: now / 1000 + 60 },
    { exp: now / 1000 + 601 },
    { kind: "mac_runner", surface: "runner" },
    { kind: "sandbox_runner", surface: "runner" },
  ])
    await expect(verifier.verify(await id.token(changes), "org")).rejects.toThrow(/^unauthorized$/);
  for (const header of [
    { alg: "none" },
    { alg: "HS256" },
    { kid: "unknown" },
    { jku: "https://other.example.invalid" },
  ])
    await expect(verifier.verify(await id.token({}, header), "org")).rejects.toThrow(
      /^unauthorized$/,
    );
  const parts = (await id.token()).split(".");
  parts[2] = base64url(crypto.getRandomValues(new Uint8Array(64)));
  await expect(verifier.verify(parts.join("."), "org")).rejects.toThrow(/^unauthorized$/);
});
it("refreshes rotated public keys on an unknown key and bounds JSON buffering", async () => {
  const first = await identity();
  const second = await identity();
  let clock = now;
  let key = first.jwk;
  const verifier = new CellTokenVerifier(
    { issuer, jwksUrl: `${issuer}/jwks` },
    async () => Response.json({ keys: [key] }),
    () => clock,
  );
  await verifier.verify(await first.token(), "org");
  clock += 1001;
  key = second.jwk;
  await verifier.verify(await second.token(), "org");
  await expect(boundedJson(Response.json({ large: "x".repeat(100) }), 20)).rejects.toThrow(
    "payload_too_large",
  );
  expect(() => bearer(new Request("https://example.invalid"))).toThrow("unauthorized");
});
