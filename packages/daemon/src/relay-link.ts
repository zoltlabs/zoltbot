import { Value } from "@sinclair/typebox/value";
import {
  type ClientFrame,
  type Handshake1,
  type Handshake2,
  type Identity,
  LinkMessage,
  type LinkSession,
  maxFrameBytes,
  maxLinkTextBytes,
  relayPaths,
  ServerFrame,
  signHello,
  toB64,
} from "@zoltbot/link";
import { WebSocket } from "ws";

// The Mac side of the mobile link (D124). zoltd dials out to the relay, signs in with the Mac
// identity, answers each phone's handshake and feeds the opened JSON-RPC text into the same
// dispatch the local server uses. The relay only ever sees sealed messages.

/** The same rule the pairing offer applies: TLS, or plain ws only on this computer. */
export const relayUrlPattern =
  /^wss:\/\/[^\s]+$|^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/;

/** One API client: the desktop UI over the local socket, or a phone over the relay. */
export interface LinkClient {
  subscribed: boolean;
  deviceId?: string;
  send(text: string): void;
}
export interface Answered {
  reply: Handshake2;
  session: LinkSession;
  deviceId: string;
}
export interface RelayLinkOptions {
  identity(): Promise<Identity>;
  /** Answers a phone's hello, or returns undefined to ignore it. */
  answer(hello: Handshake1, from: string): Promise<Answered | undefined>;
  /** A pending phone holds a session but may not call methods until the person allows it. */
  allowed(deviceId: string): boolean;
  serve(text: string, client: LinkClient): Promise<string | undefined>;
  attach(client: LinkClient): void;
  detach(client: LinkClient): void;
  /** Signed in: resend what the relay must know (the live offer, revokes). */
  ready(): void;
  presence(deviceId: string, online: boolean, lastSeenAt?: string): void;
  log(level: "info" | "warn", message: string, detail?: Record<string, unknown>): void;
  retry?: { baseMs: number; maxMs: number };
  pingMs?: number;
}
export type RelayStatus = "off" | "connecting" | "online";
export type RelayLink = ReturnType<typeof relayLink>;

const frameOverhead = 256;
function errorText(text: string, message: string, code = -32003) {
  let id: unknown = null;
  try {
    const raw = JSON.parse(text) as { id?: unknown };
    if (typeof raw?.id === "string" || typeof raw?.id === "number") id = raw.id;
  } catch {}
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function relayLink(options: RelayLinkOptions) {
  const retry = options.retry ?? { baseMs: 500, maxMs: 30_000 };
  let url: string | undefined;
  let socket: WebSocket | undefined;
  let status: RelayStatus = "off";
  let attempts = 0;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  /** Push kinds beyond needs_you and task_done that this relay announced it delivers. */
  let pushKinds = new Set<string>();
  const sessions = new Map<string, { session: LinkSession; client: LinkClient }>();
  const waiters = new Set<() => void>();

  const raw = (frame: ClientFrame) => {
    if (status !== "online" || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };
  const drop = (deviceId: string) => {
    const entry = sessions.get(deviceId);
    if (!entry) return;
    sessions.delete(deviceId);
    options.detach(entry.client);
  };
  const dropAll = () => {
    for (const deviceId of [...sessions.keys()]) drop(deviceId);
  };
  const remoteClient = (deviceId: string, session: LinkSession): LinkClient => ({
    subscribed: false,
    deviceId,
    send(text) {
      if (sessions.get(deviceId)?.session !== session) return;
      // Sealing grows the text by a third; a frame over the relay limit is refused there.
      let body = text;
      if (Buffer.byteLength(body) > maxLinkTextBytes) {
        if (!/"id"\s*:/.test(body.slice(0, 64))) {
          options.log("warn", "Relay event too large", { bytes: Buffer.byteLength(body) });
          return;
        }
        body = errorText(body, "response_too_large", -32603);
      }
      raw({ t: "data", to: deviceId, payload: session.seal(body) });
    },
  });

  async function receive(frame: ServerFrame, current: WebSocket) {
    if (frame.t === "challenge") {
      const identity = await options.identity();
      if (socket !== current) return;
      current.send(
        JSON.stringify({
          t: "hello",
          v: 1,
          role: "mac",
          publicKey: toB64(identity.publicKey),
          signature: signHello(identity, "mac", frame.nonce),
        } satisfies ClientFrame),
      );
      return;
    }
    if (frame.t === "ready") {
      status = "online";
      attempts = 0;
      for (const wake of [...waiters]) wake();
      options.log("info", "Relay connected");
      options.ready();
      return;
    }
    if (frame.t === "features") {
      pushKinds = new Set(frame.push);
      return;
    }
    if (frame.t === "error") {
      options.log("warn", "Relay refused a frame", { code: frame.code });
      return;
    }
    if (frame.t === "presence") {
      if (!frame.online) drop(frame.id);
      options.presence(frame.id, frame.online, frame.lastSeenAt);
      return;
    }
    if (!frame.from || !Value.Check(LinkMessage, frame.payload)) return;
    const from = frame.from;
    const message = frame.payload;
    if (message.t === "hs1") {
      let answered: Answered | undefined;
      try {
        answered = await options.answer(message, from);
      } catch (error) {
        options.log("warn", "Phone handshake refused", {
          code: error instanceof Error ? error.message : "unknown",
        });
        return;
      }
      if (!answered || socket !== current) return;
      drop(from);
      const client = remoteClient(from, answered.session);
      sessions.set(from, { session: answered.session, client });
      options.attach(client);
      raw({ t: "data", to: from, payload: answered.reply });
      return;
    }
    if (message.t !== "msg") return;
    const entry = sessions.get(from);
    if (!entry) return;
    let text: string;
    try {
      text = entry.session.open(message);
    } catch {
      options.log("warn", "Phone message refused");
      drop(from);
      return;
    }
    if (!options.allowed(from)) {
      entry.client.send(errorText(text, "device_not_allowed: allow this phone on your Mac first"));
      return;
    }
    void options
      .serve(text, entry.client)
      .then((response) => {
        if (response) entry.client.send(response);
      })
      .catch(() => options.log("warn", "Phone request failed"));
  }

  function schedule() {
    if (closed || !url || reconnect) return;
    const delay = Math.min(retry.maxMs, retry.baseMs * 2 ** attempts) * (0.5 + Math.random() / 2);
    attempts += 1;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      connect();
    }, delay);
    reconnect.unref?.();
  }
  function connect() {
    if (closed || !url) return;
    status = "connecting";
    pushKinds = new Set();
    const current = new WebSocket(`${url}${relayPaths.mac}`, {
      maxPayload: maxFrameBytes + frameOverhead,
      handshakeTimeout: 10_000,
    });
    socket = current;
    let alive = true;
    let queue = Promise.resolve();
    current.on("pong", () => {
      alive = true;
    });
    current.on("open", () => {
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (!alive) {
          current.terminate();
          return;
        }
        alive = false;
        current.ping();
      }, options.pingMs ?? 25_000);
      heartbeat.unref?.();
    });
    current.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!Value.Check(ServerFrame, frame)) return;
      queue = queue
        .then(() => (socket === current ? receive(frame, current) : undefined))
        .catch(() => options.log("warn", "Relay frame failed"));
    });
    current.on("error", (error) =>
      options.log("warn", "Relay connection error", { message: error.message }),
    );
    current.on("close", () => {
      if (socket !== current) return;
      clearInterval(heartbeat);
      socket = undefined;
      dropAll();
      if (status === "online") options.log("info", "Relay disconnected");
      status = url && !closed ? "connecting" : "off";
      schedule();
    });
  }
  function disconnect() {
    clearTimeout(reconnect);
    reconnect = undefined;
    clearInterval(heartbeat);
    const current = socket;
    socket = undefined;
    dropAll();
    current?.terminate();
    status = "off";
  }

  return {
    get status(): RelayStatus {
      return status;
    },
    get url() {
      return url;
    },
    /** Starts, moves or stops the link. Leave the address empty to turn it off. */
    configure(next: string | undefined) {
      const normalized = next?.trim().replace(/\/+$/, "") || undefined;
      if (normalized && !relayUrlPattern.test(normalized)) {
        options.log("warn", "Relay address refused");
        return;
      }
      if (normalized === url) return;
      disconnect();
      url = normalized;
      attempts = 0;
      connect();
    },
    /** Resolves once signed in to the relay, or false after the timeout. */
    online(timeoutMs: number) {
      if (status === "online") return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const done = (value: boolean) => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(value);
        };
        const wake = () => done(true);
        const timer = setTimeout(() => done(false), timeoutMs);
        waiters.add(wake);
      });
    },
    send: raw,
    /** Whether this relay delivers a push kind. needs_you and task_done always reach it. */
    delivers(kind: string) {
      return kind === "needs_you" || kind === "task_done" || pushKinds.has(kind);
    },
    drop,
    /** Sends to one phone's session whether or not it subscribed. */
    notify(deviceId: string, text: string) {
      sessions.get(deviceId)?.client.send(text);
    },
    close() {
      closed = true;
      url = undefined;
      disconnect();
    },
  };
}
