// P9: pushes to Android phones through Firebase Cloud Messaging (HTTP v1). The same rule as
// APNs: a fixed sentence per kind, and ids only in the data, never content.
import { sign } from "node:crypto";
import {
  type ActivityRequest,
  apnsPayload,
  type PushRequest,
  type PushResult,
  type PushSender,
} from "./push.js";

/** The parts of a Firebase service-account key the relay uses. */
export interface FcmAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmOptions {
  account: FcmAccount;
  /** Overrides for tests. */
  origin?: string;
  tokenUri?: string;
  now?: () => number;
  fetch?: typeof fetch;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** Reads a service-account key, or throws when it lacks what the relay needs. */
export function fcmAccount(json: string): FcmAccount {
  const value = JSON.parse(json) as Partial<FcmAccount>;
  if (
    typeof value.project_id !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(value.project_id) ||
    typeof value.client_email !== "string" ||
    typeof value.private_key !== "string"
  )
    throw new Error("fcm_account_invalid");
  return {
    project_id: value.project_id,
    client_email: value.client_email,
    private_key: value.private_key,
    ...(typeof value.token_uri === "string" ? { token_uri: value.token_uri } : {}),
  };
}

/** The signed assertion Google exchanges for an access token (RS256, one hour). */
export function fcmAssertion(account: FcmAccount, audience: string, issuedAt: number) {
  const iat = Math.floor(issuedAt / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: audience,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), account.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** FCM data values must be strings. */
const strings = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => key !== "body" && entry !== undefined)
      .map(
        ([key, entry]) => [key, typeof entry === "string" ? entry : JSON.stringify(entry)] as const,
      ),
  );

/**
 * The FCM message for a push. Built from the APNs payload so both platforms carry exactly the
 * same sentence and ids.
 */
export function fcmMessage(request: PushRequest) {
  const { aps, ...data } = apnsPayload(
    request.kind,
    request.count,
    request.action,
    request.threadId,
    request.cloud,
    request.macId,
  ) as { aps: { alert: { body: string }; badge?: number }; [key: string]: unknown };
  return {
    message: {
      token: request.token,
      notification: { body: aps.alert.body },
      data: strings(data),
      android: {
        priority: "high",
        notification: {
          channel_id: "default",
          ...(aps.badge !== undefined ? { notification_count: aps.badge } : {}),
        },
      },
    },
  };
}

/** Sends through FCM, keeping one access token until shortly before it expires. */
export class FcmPush implements PushSender {
  private access: { value: string; expires: number } | undefined;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: FcmOptions) {
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? fetch;
  }

  private async token() {
    const now = this.now();
    if (this.access && this.access.expires - now > 5 * 60_000) return this.access.value;
    const uri =
      this.options.tokenUri ??
      this.options.account.token_uri ??
      "https://oauth2.googleapis.com/token";
    const response = await this.fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: fcmAssertion(this.options.account, uri, now),
      }).toString(),
    });
    if (!response.ok) throw new Error(`fcm_token_${response.status}`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("fcm_token_missing");
    this.access = { value: body.access_token, expires: now + (body.expires_in ?? 3600) * 1000 };
    return this.access.value;
  }

  async send(request: PushRequest): Promise<PushResult> {
    let message: ReturnType<typeof fcmMessage>;
    try {
      message = fcmMessage(request);
    } catch {
      return { ok: false, gone: false, reason: "push_scope_invalid" };
    }
    const result = await this.post(message);
    // An access token Google stopped taking: get a fresh one and try once more.
    return result.ok || result.reason !== "status_401" ? result : this.post(message);
  }

  private async post(message: ReturnType<typeof fcmMessage>): Promise<PushResult> {
    try {
      const origin = this.options.origin ?? "https://fcm.googleapis.com";
      const project = encodeURIComponent(this.options.account.project_id);
      const response = await this.fetch(`${origin}/v1/projects/${project}/messages:send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      if (response.status === 401) {
        this.access = undefined;
        return { ok: false, gone: false, reason: "status_401" };
      }
      let reason = `status_${response.status}`;
      try {
        const body = (await response.json()) as {
          error?: { status?: string; details?: { errorCode?: string }[] };
        };
        reason =
          body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? reason;
      } catch {}
      // The phone uninstalled the app or the token rotated: forget it.
      const gone = response.status === 404 || reason === "UNREGISTERED";
      return { ok: false, gone, reason };
    } catch (error) {
      return { ok: false, gone: false, reason: (error as Error).message };
    }
  }
}

/** Sends each push through the service for its platform. */
export class RoutedPush implements PushSender {
  constructor(
    private readonly apns: PushSender,
    private readonly fcm: PushSender,
  ) {}
  send(request: PushRequest) {
    return request.platform === "fcm" ? this.fcm.send(request) : this.apns.send(request);
  }
  sendActivity = (request: ActivityRequest): Promise<PushResult> =>
    request.platform === "fcm" || !this.apns.sendActivity
      ? Promise.resolve({ ok: false, gone: false, reason: "activity_unsupported" })
      : this.apns.sendActivity(request);
  close() {
    this.apns.close?.();
    this.fcm.close?.();
  }
}
