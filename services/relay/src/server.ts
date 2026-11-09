import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ClientFrame,
  type ClientFrame as ClientFrameType,
  fromB64,
  linkId,
  maxFrameBytes,
  type RelayErrorFrame,
  relayPaths,
  type ServerFrame,
  toB64,
  verifyHello,
} from "@zoltbot/link";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { Bucket, defaultLimits, type Limits } from "./limits.js";
import type { PushSender } from "./push.js";
import type { OfferRecord, Registry } from "./registry.js";

// Layer 1 of packages/link/src/frames.ts. The relay checks who is on each socket, routes data
// frames between a Mac and the devices it allowed, and never looks inside a payload. All
// routing state lives in memory and is rebuilt as clients reconnect, so Cloud Run closing a
// socket at 60 minutes costs one reconnect and nothing else.

type Role = "mac" | "device";
type ErrorCode = Static<typeof RelayErrorFrame>["code"];
type DataFrame = Extract<ClientFrameType, { t: "data" }>;
type Frame<T extends ClientFrameType["t"]> = Extract<ClientFrameType, { t: T }>;

/** WebSocket close codes the relay uses. */
export const closeCodes = {
  badFrame: 4400,
  badSignature: 4401,
  notAllowed: 4403,
  timeout: 4408,
  replaced: 4409,
  tooSlow: 4429,
} as const;

export type LogLevel = "debug" | "info" | "warn" | "error";
/** Fields hold ids, codes and counts only. Never frame bodies. */
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export interface RelayOptions {
  registry: Registry;
  push: PushSender;
  log?: Logger;
  now?: () => number;
  limits?: Partial<Limits>;
}

interface Conn {
  ws: WebSocket;
  role: Role;
  nonce: string;
  stage: "hello" | "ready" | "closed";
  id?: string;
  /** For a device: the Mac it belongs to. */
  macId?: string;
  publicKey?: string;
  /** For a device: allowed by its Mac, or pending inside a pairing offer. */
  access?: "allowed" | "pending" | undefined;
  offer?: OfferRecord;
  frames: Bucket;
  bytes: Bucket;
  strikes: number;
  alive: boolean;
  replaced: boolean;
  queue: Promise<void>;
  timer?: NodeJS.Timeout;
}

export interface Relay {
  server: http.Server;
  /** Starts listening and resolves with the port. */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createRelay(options: RelayOptions): Relay {
  const { registry, push } = options;
  const now = options.now ?? Date.now;
  const log: Logger = options.log ?? (() => {});
  const limits: Limits = { ...defaultLimits, ...options.limits };
  const macs = new Map<string, Conn>();
  const devices = new Map<string, Map<string, Conn>>();
  const lastSeen = new Map<string, string>();
  /** Revocations this instance saw, so a sign in racing a revoke cannot slip through. */
  const revoked = new Set<string>();
  const offerUses = new Map<string, number>();

  const server = http.createServer((req, res) => {
    // Cloud Run's front end answers paths ending in "z" itself, so hosted checks use /health.
    const ok = req.method === "GET" && (req.url === "/health" || req.url === "/healthz");
    res.writeHead(ok ? 200 : 404, { "content-type": "text/plain" }).end(ok ? "ok" : "not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes * 2 });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    const role: Role | undefined =
      path === relayPaths.mac ? "mac" : path === relayPaths.device ? "device" : undefined;
    if (!role) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, role));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = conns.get(ws);
      if (!conn) continue;
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      ws.ping();
    }
  }, limits.heartbeatMs);
  heartbeat.unref();
  const conns = new WeakMap<WebSocket, Conn>();

  function accept(ws: WebSocket, role: Role) {
    const conn: Conn = {
      ws,
      role,
      nonce: toB64(randomBytes(32)),
      stage: "hello",
      frames: new Bucket(limits.frames[role], now),
      bytes: new Bucket(limits.bytes[role], now),
      strikes: 0,
      alive: true,
      replaced: false,
      queue: Promise.resolve(),
    };
    conns.set(ws, conn);
    conn.timer = setTimeout(
      () => fail(conn, "bad_frame", "hello timed out", closeCodes.timeout),
      limits.helloTimeoutMs,
    );
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (data, isBinary) => receive(conn, data, isBinary));
    ws.on("close", () => dropped(conn));
    ws.on("error", () => ws.terminate());
    send(conn, { t: "challenge", v: 1, nonce: conn.nonce });
  }

  function send(conn: Conn, frame: ServerFrame) {
    if (conn.stage === "closed" || conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > limits.maxBufferedBytes) {
      log("warn", "receiver_too_slow", { role: conn.role, id: conn.id });
      close(conn, closeCodes.tooSlow, "too slow");
      return;
    }
    conn.ws.send(JSON.stringify(frame));
  }

  function close(conn: Conn, code: number, reason: string) {
    if (conn.stage === "closed") return;
    conn.ws.close(code, reason);
    dropped(conn);
  }

  /** Sends an error frame and closes when `code` is given. */
  function fail(conn: Conn, error: ErrorCode, message: string, code?: number) {
    send(conn, { t: "error", code: error, message });
    if (code !== undefined) {
      log("info", "closed", { role: conn.role, id: conn.id, code: error });
      close(conn, code, error);
    }
  }

  /** A rejected frame. Too many of these close the connection. */
  function strike(conn: Conn, error: ErrorCode, message: string) {
    conn.strikes += 1;
    if (conn.strikes >= limits.maxStrikes || conn.stage === "hello")
      return fail(conn, error, message, closeCodes.badFrame);
    fail(conn, error, message);
  }

  function receive(conn: Conn, data: RawData, isBinary: boolean) {
    if (conn.stage === "closed") return;
    const size = Array.isArray(data)
      ? data.reduce((sum, part) => sum + part.length, 0)
      : data instanceof ArrayBuffer
        ? data.byteLength
        : data.length;
    if (!conn.frames.take() || !conn.bytes.take(size))
      return strike(conn, "rate_limited", "slow down");
    if (size > maxFrameBytes)
      return strike(conn, "too_large", `frames are at most ${maxFrameBytes} bytes`);
    if (isBinary) return strike(conn, "bad_frame", "frames are JSON text");
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return strike(conn, "bad_frame", "not JSON");
    }
    if (!Value.Check(ClientFrame, frame)) return strike(conn, "bad_frame", "unknown frame");
    const valid = frame;
    conn.queue = conn.queue
      .then(() => handle(conn, valid))
      .catch((error: unknown) => {
        log("error", "handler_failed", { role: conn.role, id: conn.id, error: String(error) });
      });
  }

  async function handle(conn: Conn, frame: ClientFrameType) {
    if (conn.stage === "closed") return;
    if (conn.stage === "hello") {
      if (frame.t !== "hello") return strike(conn, "bad_frame", "send hello first");
      return hello(conn, frame);
    }
    if (frame.t === "hello") return strike(conn, "bad_frame", "already signed in");
    if (conn.role === "mac") {
      if (frame.t === "data") return macData(conn, frame);
      if (frame.t === "offer") return offer(conn, frame);
      if (frame.t === "allow") return allow(conn, frame);
      if (frame.t === "revoke") return revoke(conn, frame);
      if (frame.t === "push") return pushTo(conn, frame);
    } else {
      if (frame.t === "data") return deviceData(conn, frame);
      if (frame.t === "push.register") return pushRegister(conn, frame);
    }
    strike(conn, "not_allowed", `${frame.t} is not for a ${conn.role}`);
  }

  // ---------- sign in ----------

  async function hello(conn: Conn, frame: Frame<"hello">) {
    if (frame.role !== conn.role)
      return fail(conn, "bad_frame", "role does not match the path", closeCodes.badFrame);
    if (!verifyHello(frame.publicKey, frame.role, conn.nonce, frame.signature))
      return fail(conn, "bad_signature", "signature does not verify", closeCodes.badSignature);
    const id = linkId(fromB64(frame.publicKey));
    conn.publicKey = frame.publicKey;
    if (conn.role === "mac") return macReady(conn, id);

    const macId = frame.macId;
    if (!macId) return fail(conn, "bad_frame", "a device must name its Mac", closeCodes.badFrame);
    const key = `${macId}/${id}`;
    const record = await registry.getDevice(macId, id);
    if (record?.status === "allowed" && !revoked.has(key)) {
      conn.access = "allowed";
    } else if (frame.offerId) {
      const offer = await registry.getOffer(frame.offerId);
      if (!offer || offer.macId !== macId || offer.expiresAt <= now())
        return fail(conn, "offer_expired", "the pairing offer is not live", closeCodes.notAllowed);
      const uses = (offerUses.get(offer.offerId) ?? 0) + 1;
      offerUses.set(offer.offerId, uses);
      if (uses > limits.offerAttempts)
        return fail(conn, "rate_limited", "too many tries for this offer", closeCodes.notAllowed);
      conn.access = "pending";
      conn.offer = offer;
    } else {
      return fail(conn, "not_allowed", "this device is not allowed", closeCodes.notAllowed);
    }
    if (conn.stage === "closed") return;
    deviceReady(conn, macId, id);
  }

  function ready(conn: Conn, id: string) {
    clearTimeout(conn.timer);
    conn.stage = "ready";
    conn.id = id;
    send(conn, { t: "ready", id });
  }

  function macReady(conn: Conn, id: string) {
    const previous = macs.get(id);
    if (previous) replace(previous);
    macs.set(id, conn);
    ready(conn, id);
    log("info", "mac_ready", { id });
    for (const device of devices.get(id)?.values() ?? []) {
      send(device, { t: "presence", id, online: true });
      if (device.access === "allowed")
        send(conn, { t: "presence", id: device.id ?? "", online: true });
    }
  }

  function deviceReady(conn: Conn, macId: string, id: string) {
    const group = devices.get(macId) ?? new Map<string, Conn>();
    devices.set(macId, group);
    const previous = group.get(id);
    if (previous) replace(previous);
    group.set(id, conn);
    conn.macId = macId;
    ready(conn, id);
    log("info", "device_ready", { id, macId, access: conn.access });
    const mac = macs.get(macId);
    send(conn, presence(macId, Boolean(mac)));
    if (mac && conn.access === "allowed") send(mac, { t: "presence", id, online: true });
    if (conn.access === "pending" && conn.offer) {
      conn.timer = setTimeout(
        () => {
          if (conn.access === "pending")
            fail(conn, "offer_expired", "the pairing offer ended", closeCodes.timeout);
        },
        Math.max(0, conn.offer.expiresAt - now()),
      );
    }
  }

  function presence(id: string, online: boolean): ServerFrame {
    const seen = lastSeen.get(id);
    return online || !seen
      ? { t: "presence", id, online }
      : { t: "presence", id, online, lastSeenAt: seen };
  }

  function replace(previous: Conn) {
    previous.replaced = true;
    close(previous, closeCodes.replaced, "signed in elsewhere");
  }

  function dropped(conn: Conn) {
    if (conn.stage === "closed") return;
    const wasReady = conn.stage === "ready";
    conn.stage = "closed";
    clearTimeout(conn.timer);
    if (!wasReady || !conn.id) return;
    const id = conn.id;
    if (conn.role === "mac") {
      if (macs.get(id) === conn) macs.delete(id);
      if (conn.replaced) return;
      lastSeen.set(id, new Date(now()).toISOString());
      for (const device of devices.get(id)?.values() ?? []) send(device, presence(id, false));
      log("info", "mac_dropped", { id });
      return;
    }
    const macId = conn.macId ?? "";
    const group = devices.get(macId);
    if (group?.get(id) === conn) group.delete(id);
    if (group?.size === 0) devices.delete(macId);
    if (conn.replaced) return;
    lastSeen.set(id, new Date(now()).toISOString());
    const mac = macs.get(macId);
    if (mac && conn.access === "allowed") send(mac, presence(id, false));
    log("info", "device_dropped", { id, macId });
  }

  // ---------- Mac frames ----------

  function liveDevice(macId: string, deviceId: string) {
    const device = devices.get(macId)?.get(deviceId);
    if (!device || device.stage !== "ready") return undefined;
    if (device.access === "pending" && (device.offer?.expiresAt ?? 0) <= now()) return undefined;
    return device;
  }

  function macData(conn: Conn, frame: DataFrame) {
    const macId = conn.id ?? "";
    if (!frame.to || frame.from) return strike(conn, "bad_frame", "a Mac sets to and not from");
    const device = liveDevice(macId, frame.to);
    if (!device) return; // Offline. Presence already told the Mac.
    send(device, { t: "data", from: macId, payload: frame.payload });
  }

  async function offer(conn: Conn, frame: Frame<"offer">) {
    const macId = conn.id ?? "";
    const expiresAt = Math.min(Date.parse(frame.expiresAt), now() + limits.offerTtlMs);
    if (Number.isNaN(expiresAt) || expiresAt <= now())
      return strike(conn, "offer_expired", "the offer has already ended");
    const existing = await registry.getOffer(frame.offerId);
    if (existing && existing.macId !== macId)
      return strike(conn, "not_allowed", "that offer id is taken");
    await registry.putOffer({ offerId: frame.offerId, macId, expiresAt });
    log("info", "offer_opened", { macId });
  }

  async function allow(conn: Conn, frame: Frame<"allow">) {
    const macId = conn.id ?? "";
    const device = devices.get(macId)?.get(frame.deviceId);
    revoked.delete(`${macId}/${frame.deviceId}`);
    await registry.allowDevice(macId, frame.deviceId, device?.publicKey);
    log("info", "device_allowed", { macId, deviceId: frame.deviceId });
    if (device && device.stage === "ready" && device.access === "pending") {
      device.access = "allowed";
      clearTimeout(device.timer);
      send(conn, { t: "presence", id: frame.deviceId, online: true });
    }
  }

  async function revoke(conn: Conn, frame: Frame<"revoke">) {
    const macId = conn.id ?? "";
    revoked.add(`${macId}/${frame.deviceId}`);
    const device = devices.get(macId)?.get(frame.deviceId);
    if (device) {
      device.access = undefined;
      fail(device, "not_allowed", "this device was removed", closeCodes.notAllowed);
    }
    await registry.revokeDevice(macId, frame.deviceId);
    log("info", "device_revoked", { macId, deviceId: frame.deviceId });
  }

  async function pushTo(conn: Conn, frame: Frame<"push">) {
    const macId = conn.id ?? "";
    const record = await registry.getDevice(macId, frame.deviceId);
    if (record?.status !== "allowed" || !record.pushToken || !record.platform) return;
    const request = {
      platform: record.platform,
      token: record.pushToken,
      kind: frame.kind,
      count: frame.count,
      ...(frame.category === "approval" &&
      frame.interactionId !== undefined &&
      frame.threadId !== undefined &&
      frame.version !== undefined
        ? {
            action: {
              category: frame.category,
              interactionId: frame.interactionId,
              threadId: frame.threadId,
              version: frame.version,
            },
          }
        : {}),
    };
    // Not awaited, so a slow APNs never holds up this Mac's data frames.
    void push
      .send(request)
      .then(async (result) => {
        if (result.ok) return log("debug", "push_sent", { macId, deviceId: frame.deviceId });
        log("warn", "push_failed", { macId, deviceId: frame.deviceId, reason: result.reason });
        if (result.gone) await registry.clearPushToken(macId, frame.deviceId);
      })
      .catch((error: unknown) => log("error", "push_failed", { error: String(error) }));
  }

  // ---------- device frames ----------

  function deviceData(conn: Conn, frame: DataFrame) {
    if (frame.to || frame.from)
      return strike(conn, "bad_frame", "a device sets neither to nor from");
    if (conn.access === "pending" && (conn.offer?.expiresAt ?? 0) <= now())
      return fail(conn, "offer_expired", "the pairing offer ended", closeCodes.timeout);
    if (!conn.access)
      return fail(conn, "not_allowed", "this device is not allowed", closeCodes.notAllowed);
    const mac = macs.get(conn.macId ?? "");
    if (!mac) return fail(conn, "mac_offline", "the Mac is offline");
    send(mac, { t: "data", from: conn.id ?? "", payload: frame.payload });
  }

  async function pushRegister(conn: Conn, frame: Frame<"push.register">) {
    if (conn.access !== "allowed")
      return strike(conn, "not_allowed", "pair before registering for pushes");
    const stored = await registry.setPushToken(
      conn.macId ?? "",
      conn.id ?? "",
      frame.platform,
      frame.token,
    );
    if (!stored) strike(conn, "not_allowed", "this device is not allowed");
  }

  return {
    server,
    listen(port = 0, host?: string) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
