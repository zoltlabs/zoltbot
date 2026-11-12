import { env } from "cloudflare:workers";
import { base64url } from "../src/auth.js";
export async function signer() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const kid = crypto.randomUUID();
  return {
    jwk: { kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid, x: exported.x, y: exported.y },
    async token(org: string, changes: Record<string, unknown> = {}) {
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
          ...changes,
        },
      ]
        .map((value) => base64url(new TextEncoder().encode(JSON.stringify(value))))
        .join(".");
      return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(input))))}`;
    },
  };
}
