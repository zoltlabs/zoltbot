import { sign } from "node:crypto";
import http2 from "node:http2";
import type { PushKind } from "@zoltbot/link";
import type { PushPlatform } from "./registry.js";

// Pushes carry no content. The text is fixed per kind; the app fetches details over the link.

export type { PushKind };

/** A simple approval the app can answer from the notification. Ids only, never text. */
export interface PushAction {
  category: "approval";
  interactionId: string;
  threadId: string;
  version: number;
}
export interface PushRequest {
  platform: PushPlatform;
  token: string;
  kind: PushKind;
  count: number;
  action?: PushAction;
  /** The chat a tap opens, for a push with no action. An id, never text. */
  threadId?: string;
}

/** `gone` means APNs says the token is no longer valid and should be forgotten. */
export type PushResult = { ok: true } | { ok: false; gone: boolean; reason: string };

export interface PushSender {
  send(request: PushRequest): Promise<PushResult>;
  close?(): void;
}

export function pushText(kind: PushKind, count: number) {
  if (kind === "task_done") return "A task finished";
  if (kind === "zolt") return "A message from your main agent";
  return count > 1 ? `Zoltbot needs you (${count})` : "Zoltbot needs you";
}

export function apnsPayload(kind: PushKind, count: number, action?: PushAction, threadId?: string) {
  // A notice is not a request, so it leaves the badge (what needs you) as it is.
  const aps =
    kind === "zolt"
      ? { alert: { body: pushText(kind, count) }, sound: "default" }
      : { alert: { body: pushText(kind, count) }, badge: count, sound: "default" };
  if (!action) return threadId ? { aps, threadId, body: { threadId } } : { aps };
  // The app registers the "approval" category with Allow once and Reject buttons. The ids sit
  // at the top level of the APNs payload (the app's notification data) and are mirrored under
  // `body`, which expo-notifications prefers as data when present.
  const data = {
    category: action.category,
    interactionId: action.interactionId,
    version: action.version,
    threadId: action.threadId,
  };
  return { aps: { ...aps, category: action.category }, ...data, body: data };
}

/** Records pushes for tests. */
export class FakePush implements PushSender {
  readonly sent: PushRequest[] = [];
  constructor(
    private readonly result: (request: PushRequest) => PushResult = () => ({ ok: true }),
  ) {}
  async send(request: PushRequest) {
    this.sent.push(request);
    return this.result(request);
  }
}

/** Used when no APNs key is configured. */
export class DisabledPush implements PushSender {
  async send(): Promise<PushResult> {
    return { ok: false, gone: false, reason: "push_disabled" };
  }
}

export interface ApnsOptions {
  /** The .p8 key in PEM form. */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
  origins?: Partial<Record<PushPlatform, string>>;
  now?: () => number;
}

const defaultOrigins: Record<PushPlatform, string> = {
  apns: "https://api.push.apple.com",
  "apns-sandbox": "https://api.sandbox.push.apple.com",
};
const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** Token based provider JWT, ES256. APNs wants it refreshed between 20 and 60 minutes. */
export function apnsJwt(key: string, keyId: string, teamId: string, issuedAt: number) {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(issuedAt / 1000) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${b64url(signature)}`;
}

/** HTTP/2 APNs client with one cached session per origin. */
export class ApnsPush implements PushSender {
  private readonly origins: Record<PushPlatform, string>;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private readonly now: () => number;
  private jwt?: { value: string; issuedAt: number };

  constructor(private readonly options: ApnsOptions) {
    this.origins = { ...defaultOrigins, ...options.origins };
    this.now = options.now ?? Date.now;
  }

  private token() {
    const now = this.now();
    if (!this.jwt || now - this.jwt.issuedAt > 40 * 60 * 1000) {
      const { key, keyId, teamId } = this.options;
      this.jwt = { value: apnsJwt(key, keyId, teamId, now), issuedAt: now };
    }
    return this.jwt.value;
  }

  private session(origin: string) {
    const current = this.sessions.get(origin);
    if (current && !current.closed && !current.destroyed) return current;
    const session = http2.connect(origin);
    session.on("error", () => this.sessions.delete(origin));
    session.on("close", () => this.sessions.delete(origin));
    session.on("goaway", () => this.sessions.delete(origin));
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  send(request: PushRequest): Promise<PushResult> {
    const body = JSON.stringify(
      apnsPayload(request.kind, request.count, request.action, request.threadId),
    );
    return new Promise((resolve) => {
      let stream: http2.ClientHttp2Stream;
      try {
        stream = this.session(this.origins[request.platform]).request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(request.token)}`,
          authorization: `bearer ${this.token()}`,
          "apns-topic": this.options.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
      } catch (error) {
        resolve({ ok: false, gone: false, reason: (error as Error).message });
        return;
      }
      let status = 0;
      let text = "";
      stream.setEncoding("utf8");
      stream.setTimeout(10_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      stream.on("data", (chunk: string) => {
        text += chunk;
      });
      stream.on("error", (error) => resolve({ ok: false, gone: false, reason: error.message }));
      stream.on("close", () => {
        if (status === 200) return resolve({ ok: true });
        let reason = status ? `status_${status}` : "no_response";
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? reason;
        } catch {}
        const gone = status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
        resolve({ ok: false, gone, reason });
      });
      stream.end(body);
    });
  }

  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
