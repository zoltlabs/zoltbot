import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { checkedDestination, type DestinationPolicy, requestJson } from "./network.js";

export interface OAuthConfiguration {
  identity: string;
  issuer: string;
  resource: string;
  clientId: string;
  registrationEndpoint?: string;
  authorizationResource?: string;
  issuerParameterRequired?: boolean;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  policy: DestinationPolicy;
}
export interface OAuthCredential {
  registration?: OAuthConfiguration;
  issuer: string;
  resource: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}
export interface OAuthPending {
  authorizationUrl: string;
  result: Promise<{ reference: string }>;
  cancel(): void;
}
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function credential(value: Record<string, unknown>, config: OAuthConfiguration): OAuthCredential {
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    [...value.access_token].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    ) ||
    value.access_token.length > 16384 ||
    (value.expires_in !== undefined &&
      (typeof value.expires_in !== "number" ||
        !Number.isFinite(value.expires_in) ||
        value.expires_in < 0)) ||
    String(value.token_type).toLowerCase() !== "bearer" ||
    (value.scope !== undefined &&
      (typeof value.scope !== "string" ||
        value.scope.split(" ").some((s) => !config.scopes.includes(s))))
  )
    throw new Error("oauth_invalid_token_response");
  return {
    registration: structuredClone(config),
    issuer: config.issuer,
    resource: config.resource,
    accessToken: value.access_token,
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    ...(typeof value.expires_in === "number" && value.expires_in >= 0
      ? { expiresAt: Date.now() + value.expires_in * 1000 }
      : {}),
  };
}
/** Public clients with explicitly configured registration; no fabricated client secrets. */
export class ConnectionOAuth {
  private readonly pending = new Set<string>();
  constructor(
    private readonly vault: {
      put(value: unknown): Promise<{ reference: string }>;
      replace?(reference: string, value: unknown): Promise<void>;
      remove?(reference: string): Promise<void>;
    },
  ) {}
  async start(config: OAuthConfiguration, timeoutMs = 180000): Promise<OAuthPending> {
    if (this.pending.has(config.identity)) throw new Error("oauth_already_pending");
    this.pending.add(config.identity);
    try {
      await checkedDestination(config.issuer, config.policy);
      await checkedDestination(config.resource, config.policy);
      await checkedDestination(config.authorizationEndpoint, config.policy);
      await checkedDestination(config.tokenEndpoint, config.policy);
    } catch (error) {
      this.pending.delete(config.identity);
      throw error;
    }
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let resolve!: (value: { reference: string }) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<{ reference: string }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Avoid an unhandled rejection while the UI waits to consume the pending result.
    void result.catch(() => {});
    let used = false;
    let completed = false;
    const controller = new AbortController();
    let redirect = "";
    const finish = () => {
      clearTimeout(timer);
      server.close();
      this.pending.delete(config.identity);
    };
    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      used = true;
      controller.abort();
      finish();
      reject(new Error(message));
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect);
      if (
        req.method !== "GET" ||
        url.pathname !== new URL(redirect).pathname ||
        req.headers.host !== new URL(redirect).host
      ) {
        res.writeHead(404).end();
        return;
      }
      if (used) {
        res.writeHead(409).end("Sign-in already handled.");
        return;
      }
      if (
        url.searchParams.getAll("state").length !== 1 ||
        !equal(url.searchParams.get("state") ?? "", state) ||
        (url.searchParams.has("iss")
          ? url.searchParams.get("iss") !== config.issuer
          : config.issuerParameterRequired !== false) ||
        url.searchParams.has("error") ||
        url.searchParams.getAll("code").length !== 1 ||
        !url.searchParams.get("code")
      ) {
        res.writeHead(400).end("Sign-in could not be verified. Try again.");
        fail("oauth_callback_rejected");
        return;
      }
      used = true;
      res
        .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
        .end("You can return to Zoltbot.");
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: url.searchParams.get("code") as string,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource: config.authorizationResource ?? config.resource,
      });
      void requestJson(config.tokenEndpoint, config.policy, form, { signal: controller.signal })
        .then((value) => {
          if (completed) throw new Error("oauth_cancelled");
          return this.vault.put(credential(value, config));
        })
        .then(
          (value) => {
            if (completed) {
              void this.vault.remove?.(value.reference);
              return;
            }
            completed = true;
            finish();
            resolve(value);
          },
          () => {
            if (completed) return;
            completed = true;
            finish();
            reject(new Error("oauth_token_exchange_failed"));
          },
        );
    });
    const timer = setTimeout(() => fail("oauth_timeout"), timeoutMs);
    timer.unref();
    try {
      await new Promise<void>((yes, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", yes);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error();
      redirect = `http://127.0.0.1:${address.port}/callback${config.issuerParameterRequired === false ? `/${createHash("sha256").update(config.issuer).digest("hex").slice(0, 16)}` : ""}`;
      // Register only after reserving this exact callback. No registration secret is accepted.
      if (config.registrationEndpoint) {
        const registered = await requestJson(
          config.registrationEndpoint,
          config.policy,
          undefined,
          {
            signal: controller.signal,
            created: true,
            json: {
              client_name: "Zoltbot",
              scope: config.scopes.join(" "),
              redirect_uris: [redirect],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
          },
        );
        if (
          typeof registered.client_id !== "string" ||
          !registered.client_id ||
          registered.client_id.length > 2048 ||
          registered.client_secret ||
          (registered.token_endpoint_auth_method !== undefined &&
            registered.token_endpoint_auth_method !== "none") ||
          !Array.isArray(registered.redirect_uris) ||
          !registered.redirect_uris.includes(redirect)
        )
          throw new Error("oauth_public_registration_required");
        config = { ...config, clientId: registered.client_id };
      }
      if (completed) throw new Error("oauth_cancelled");
      const url = new URL(config.authorizationEndpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirect,
        scope: config.scopes.join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: config.authorizationResource ?? config.resource,
      }).toString();
      return { authorizationUrl: url.toString(), result, cancel: () => fail("oauth_cancelled") };
    } catch {
      fail("oauth_setup_failed");
      throw new Error("oauth_setup_failed");
    }
  }
  async refresh(config: OAuthConfiguration, prior: OAuthCredential, reference?: string) {
    if (prior.issuer !== config.issuer || prior.resource !== config.resource || !prior.refreshToken)
      throw new Error("oauth_refresh_binding_mismatch");
    try {
      const value = await requestJson(
        config.tokenEndpoint,
        config.policy,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: prior.refreshToken,
          client_id: config.clientId,
          resource: config.authorizationResource ?? config.resource,
        }),
      );
      const next = credential(value, config);
      // Rotation is committed to the vault before the caller changes its metadata reference.
      const rotated = { ...next, refreshToken: next.refreshToken ?? prior.refreshToken };
      if (reference) {
        if (!this.vault.replace) throw new Error("oauth_refresh_storage_unavailable");
        await this.vault.replace(reference, rotated);
        return { reference };
      }
      return await this.vault.put(rotated);
    } catch {
      throw new Error("oauth_refresh_failed");
    }
  }
}
