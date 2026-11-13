import {
  CellJwkSchema,
  type CellTokenClaims,
  CellTokenClaimsSchema,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";

type Identity = Omit<CellTokenClaims, "iss" | "aud" | "iat" | "exp" | "jti">;
const encode = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** Ephemeral fixture signer. Only public JWKS and scoped tokens leave its closure. */
export async function createCellIdentity(options: { issuer: string; now?: () => number }) {
  const { issuer } = options,
    now = options.now ?? Date.now;
  const origin = new URL(issuer);
  if (
    origin.origin !== issuer ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "127.0.0.1"))
  )
    throw new Error("fixture_identity_invalid");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const jwk = parse(CellJwkSchema, {
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    use: "sig",
    kid: crypto.randomUUID(),
    x: publicKey.x,
    y: publicKey.y,
  });
  return Object.freeze({
    jwks: () => ({ keys: [structuredClone(jwk)] }),
    async issue(input: Identity, lifetimeSeconds = 600) {
      const maximum = input.kind === "sandbox_runner" ? 86400 : 600;
      if (
        !Number.isSafeInteger(lifetimeSeconds) ||
        lifetimeSeconds < 1 ||
        lifetimeSeconds > maximum ||
        Object.keys(input).some(
          (key) =>
            !["sub", "org", "device", "surface", "kind", "session", "task", "grant"].includes(key),
        )
      )
        throw new Error("fixture_identity_invalid");
      const seconds = Math.floor(now() / 1000);
      const claims = parse(CellTokenClaimsSchema, {
        ...input,
        iss: issuer,
        aud: "cell",
        iat: seconds,
        exp: seconds + lifetimeSeconds,
        jti: crypto.randomUUID(),
      });
      if (
        (claims.kind === "client" &&
          (!claims.session ||
            !["desktop", "phone"].includes(claims.surface) ||
            claims.task !== undefined ||
            claims.grant !== undefined)) ||
        (claims.kind === "mac_runner" &&
          (claims.surface !== "runner" ||
            !claims.session ||
            !claims.grant ||
            claims.task !== undefined)) ||
        (claims.kind === "sandbox_runner" &&
          (claims.surface !== "runner" ||
            !claims.task ||
            claims.session !== undefined ||
            claims.grant !== undefined))
      )
        throw new Error("fixture_identity_invalid");
      const message = `${encode({ alg: "ES256", typ: "JWT", kid: jwk.kid })}.${encode(claims)}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          new TextEncoder().encode(message),
        ),
      );
      const encoded = btoa(String.fromCharCode(...signature))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      return `${message}.${encoded}`;
    },
  });
}
