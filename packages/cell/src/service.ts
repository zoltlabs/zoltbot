import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { base64url, boundedJson, decodeBase64url } from "./auth.js";

const encoder = new TextEncoder();
export type ServiceAudience = "orchestrator" | "cell-service";
export interface ServiceClaims {
  iss: string;
  aud: ServiceAudience;
  sub: string;
  org: string;
  iat: number;
  exp: number;
  jti: string;
}
async function key(secret: string) {
  const bytes = decodeBase64url(secret);
  if (bytes.byteLength < 32) throw new Error("service_unavailable");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
export async function serviceToken(
  secret: string,
  issuer: string,
  audience: ServiceAudience,
  org: string,
  now = Date.now(),
): Promise<string> {
  const claims: ServiceClaims = {
    iss: issuer,
    aud: audience,
    sub: "cell",
    org,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 120,
    jti: crypto.randomUUID(),
  };
  const input = `${base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}
export async function verifyServiceToken(
  token: string,
  secret: string,
  issuer: string,
  audience: ServiceAudience,
  org: string,
  now = Date.now(),
): Promise<void> {
  try {
    if (token.length > 8192) throw new Error("unauthorized");
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("unauthorized");
    const header = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0])));
    const claims: ServiceClaims = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));
    const seconds = Math.floor(now / 1000);
    if (
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      Object.keys(header).some((name) => !["alg", "typ"].includes(name)) ||
      claims.iss !== issuer ||
      claims.aud !== audience ||
      claims.org !== org ||
      claims.sub !== "cell" ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= seconds ||
      claims.iat > seconds + 30 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 120 ||
      typeof claims.jti !== "string" ||
      !claims.jti
    )
      throw new Error("unauthorized");
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        decodeBase64url(parts[2]),
        encoder.encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      throw new Error("unauthorized");
  } catch {
    throw new Error("unauthorized");
  }
}
export interface ServiceConfig {
  origin: string;
  signingKey: string;
  issuer: string;
}
export class CellService {
  private readonly access = new Map<string, number>();
  constructor(
    private readonly config: ServiceConfig,
    private readonly orgId: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}
  async request(path: string, method: string, body: unknown): Promise<unknown> {
    const base = this.config.origin.replace(/\/?$/, "/");
    const url = new URL(path.replace(/^\//, ""), base);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
      throw new Error("service_unavailable");
    const response = await this.fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${await serviceToken(this.config.signingKey, this.config.issuer, "orchestrator", this.orgId)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const result = await boundedJson(response, 262144);
    if (!response.ok) {
      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        result.error === "limit_reached"
      )
        throw new Error("limit_reached");
      throw new Error("service_unavailable");
    }
    return result;
  }
  async authorize(claims: CellTokenClaims, now = Date.now(), fresh = false): Promise<void> {
    if (claims.org !== this.orgId || claims.exp <= Math.floor(now / 1000))
      throw new Error("unauthorized");
    const id = JSON.stringify([
      claims.sub,
      claims.device,
      claims.kind,
      claims.grant,
      claims.task,
      claims.jti,
      claims.session,
    ]);
    if (!fresh && (this.access.get(id) ?? 0) > now) return;
    const response = await this.request("access", "POST", {
      orgId: claims.org,
      userId: claims.sub,
      deviceId: claims.device,
      kind: claims.kind,
      ...(claims.session ? { sessionId: claims.session } : {}),
      surface: claims.surface,
      ...(claims.grant ? { grantId: claims.grant } : {}),
      ...(claims.task ? { taskId: claims.task } : {}),
    });
    if (
      !response ||
      typeof response !== "object" ||
      !("active" in response) ||
      response.active !== true
    ) {
      this.access.delete(id);
      throw new Error("unauthorized");
    }
    for (const [key, expiry] of this.access) if (expiry <= now) this.access.delete(key);
    if (this.access.size >= 128) {
      const oldest = this.access.keys().next().value;
      if (oldest !== undefined) this.access.delete(oldest);
    }
    this.access.set(id, Math.min(now + 30000, claims.exp * 1000));
  }
  invalidate() {
    this.access.clear();
  }
}
