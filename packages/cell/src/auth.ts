import {
  CellJwksSchema,
  type CellTokenClaims,
  CellTokenClaimsSchema,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";

const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("unauthorized");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
}
function jsonPart(value: string): Record<string, unknown> {
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decodeBase64url(value)),
  );
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("unauthorized");
  return decoded;
}
export async function boundedJson(input: Request | Response, limit = 65536): Promise<unknown> {
  if (!input.body) throw new Error("invalid_json");
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("payload_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}
export interface CellAuthConfig {
  jwksUrl: string;
  issuer: string;
}
/** This cache holds public verification keys only, never user or org state. */
export class CellTokenVerifier {
  private keys = new Map<string, CryptoKey>();
  private expiresAt = 0;
  private refreshedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly config: CellAuthConfig,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = () => Date.now(),
  ) {}
  private async refresh(force = false) {
    if (!force && this.expiresAt > this.now()) return;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      this.refreshedAt = this.now();
      const url = new URL(this.config.jwksUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
        throw new Error("unauthorized");
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("unauthorized");
      const jwks = parse(CellJwksSchema, await boundedJson(response));
      if (!jwks.keys.length || jwks.keys.length > 32) throw new Error("unauthorized");
      const entries = await Promise.all(
        jwks.keys.map(
          async (jwk) =>
            [
              jwk.kid,
              await crypto.subtle.importKey(
                "jwk",
                jwk,
                { name: "ECDSA", namedCurve: "P-256" },
                false,
                ["verify"],
              ),
            ] as const,
        ),
      );
      if (new Set(entries.map(([kid]) => kid)).size !== entries.length)
        throw new Error("unauthorized");
      this.keys = new Map(entries);
      this.expiresAt = this.now() + 600_000;
    })();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  async verify(token: string, orgId: string): Promise<CellTokenClaims> {
    try {
      if (token.length > 16384) throw new Error("unauthorized");
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("unauthorized");
      const [headerText, payloadText, signatureText] = parts;
      if (!headerText || !payloadText || !signatureText) throw new Error("unauthorized");
      const header = jsonPart(headerText);
      if (
        header.alg !== "ES256" ||
        typeof header.kid !== "string" ||
        !header.kid ||
        header.kid.length > 200 ||
        (header.typ !== undefined && header.typ !== "JWT") ||
        Object.keys(header).some((key) => !["alg", "kid", "typ"].includes(key))
      )
        throw new Error("unauthorized");
      const claims = parse(CellTokenClaimsSchema, jsonPart(payloadText));
      const seconds = Math.floor(this.now() / 1000);
      const maximum = claims.kind === "sandbox_runner" ? 86400 : 600;
      if (
        claims.iss !== this.config.issuer ||
        claims.org !== orgId ||
        claims.exp <= seconds ||
        claims.iat > seconds + 30 ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > maximum
      )
        throw new Error("unauthorized");
      if (
        claims.kind === "client" &&
        (!claims.session ||
          !["desktop", "phone"].includes(claims.surface) ||
          claims.task !== undefined ||
          claims.grant !== undefined)
      )
        throw new Error("unauthorized");
      if (
        claims.kind === "mac_runner" &&
        (claims.surface !== "runner" ||
          !claims.grant ||
          !claims.session ||
          claims.task !== undefined)
      )
        throw new Error("unauthorized");
      if (
        claims.kind === "sandbox_runner" &&
        (claims.surface !== "runner" ||
          !claims.task ||
          claims.grant !== undefined ||
          claims.session !== undefined)
      )
        throw new Error("unauthorized");
      const signature = decodeBase64url(signatureText);
      if (signature.byteLength !== 64) throw new Error("unauthorized");
      await this.refresh();
      if (!this.keys.has(header.kid) && this.now() - this.refreshedAt >= 1000)
        await this.refresh(true);
      const key = this.keys.get(header.kid);
      if (
        !key ||
        !(await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          signature,
          encoder.encode(`${headerText}.${payloadText}`),
        ))
      )
        throw new Error("unauthorized");
      return claims;
    } catch {
      throw new Error("unauthorized");
    }
  }
}
export function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match?.[1]) throw new Error("unauthorized");
  return match[1];
}
