import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Value } from "@sinclair/typebox/value";
import {
  ClientFrame,
  createIdentity,
  fromB64,
  type Handshake2,
  type LinkSession,
  linkId,
  PairingOffer,
  parsePairingUrl,
  relayPaths,
  type SealedMessage,
  type ServerFrame,
  signHello,
  startHandshake,
  toB64,
  verifyHello,
} from "@zoltbot/link";
import { WebSocket, WebSocketServer } from "ws";

// Test support only (D124): an in-process relay that speaks the frames, and a phone that pairs
// through it. It keeps its registry across Mac reconnects, like the hosted relay.

interface Peer {
  socket: WebSocket;
  id: string;
  role: "mac" | "device";
  macId?: string;
}
export type FakeRelay = Awaited<ReturnType<typeof startFakeRelay>>;
export async function startFakeRelay() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const macs = new Map<string, Peer>();
  const devices = new Map<string, Peer>();
  const offers = new Map<string, { offerId: string; expiresAt: number }>();
  const allowed = new Map<string, Set<string>>();
  const fromMac: ClientFrame[] = [];
  let macSignIns = 0;
  const send = (socket: WebSocket | undefined, frame: ServerFrame) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  const isAllowed = (macId: string, deviceId: string) => allowed.get(macId)?.has(deviceId) ?? false;
  const offerLive = (macId: string) => (offers.get(macId)?.expiresAt ?? 0) > Date.now();

  server.on("connection", (socket, request) => {
    const role = request.url === relayPaths.mac ? "mac" : "device";
    const nonce = toB64(randomBytes(16));
    let peer: Peer | undefined;
    send(socket, { t: "challenge", v: 1, nonce });
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!Value.Check(ClientFrame, frame)) {
        send(socket, { t: "error", code: "bad_frame", message: "bad frame" });
        return;
      }
      if (!peer) {
        if (frame.t !== "hello" || frame.role !== role) return socket.close();
        if (!verifyHello(frame.publicKey, role, nonce, frame.signature)) {
          send(socket, { t: "error", code: "bad_signature", message: "bad signature" });
          return socket.close();
        }
        const id = linkId(fromB64(frame.publicKey));
        if (role === "device") {
          const macId = frame.macId ?? "";
          const offer = offers.get(macId);
          if (!isAllowed(macId, id) && !(offer?.offerId === frame.offerId && offerLive(macId))) {
            send(socket, { t: "error", code: "not_allowed", message: "not allowed" });
            return socket.close();
          }
          peer = { socket, id, role, macId };
          devices.set(id, peer);
          send(socket, { t: "ready", id });
          send(macs.get(macId)?.socket, { t: "presence", id, online: true });
          send(socket, { t: "presence", id: macId, online: macs.has(macId) });
        } else {
          peer = { socket, id, role };
          macs.get(id)?.socket.terminate();
          macs.set(id, peer);
          macSignIns += 1;
          send(socket, { t: "ready", id });
          for (const device of devices.values())
            if (device.macId === id) {
              send(socket, { t: "presence", id: device.id, online: true });
              send(device.socket, { t: "presence", id, online: true });
            }
        }
        return;
      }
      if (peer.role === "mac") {
        fromMac.push(frame);
        const macId = peer.id;
        if (frame.t === "offer")
          offers.set(macId, { offerId: frame.offerId, expiresAt: Date.parse(frame.expiresAt) });
        if (frame.t === "allow") {
          const set = allowed.get(macId) ?? new Set();
          set.add(frame.deviceId);
          allowed.set(macId, set);
        }
        if (frame.t === "revoke") {
          allowed.get(macId)?.delete(frame.deviceId);
          devices.get(frame.deviceId)?.socket.close();
        }
        if (frame.t === "data" && frame.to) {
          const device = devices.get(frame.to);
          if (device?.macId === macId)
            send(device.socket, { t: "data", from: macId, payload: frame.payload });
        }
        return;
      }
      if (frame.t !== "data") return;
      const macId = peer.macId ?? "";
      if (!isAllowed(macId, peer.id) && !offerLive(macId)) {
        send(socket, { t: "error", code: "not_allowed", message: "not allowed" });
        return;
      }
      const mac = macs.get(macId);
      if (!mac) send(socket, { t: "error", code: "mac_offline", message: "Mac offline" });
      else send(mac.socket, { t: "data", from: peer.id, payload: frame.payload });
    });
    socket.on("close", () => {
      if (!peer) return;
      if (peer.role === "mac" && macs.get(peer.id)?.socket === socket) {
        macs.delete(peer.id);
        for (const device of devices.values())
          if (device.macId === peer.id)
            send(device.socket, { t: "presence", id: peer.id, online: false });
      }
      if (peer.role === "device" && devices.get(peer.id)?.socket === socket) {
        devices.delete(peer.id);
        const lastSeenAt = new Date().toISOString();
        send(macs.get(peer.macId ?? "")?.socket, {
          t: "presence",
          id: peer.id,
          online: false,
          lastSeenAt,
        });
      }
    });
  });
  return {
    url,
    fromMac,
    macOnline: () => macs.size > 0,
    macSignIns: () => macSignIns,
    allowed: (deviceId: string) => [...allowed.values()].some((set) => set.has(deviceId)),
    /** Drops every Mac connection, as a relay restart or Cloud Run timeout would. */
    dropMacs() {
      for (const mac of macs.values()) mac.socket.terminate();
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A phone that scans the QR text, pairs, and speaks JSON-RPC through the sealed link. */
export async function fakePhone(qr: string, name = "Test iPhone") {
  const offer = Value.Parse(PairingOffer, parsePairingUrl(qr));
  const identity = createIdentity();
  const macKey = fromB64(offer.macKey);
  const events: { type: string; payload: unknown }[] = [];
  let socket: WebSocket | undefined;
  let session: (LinkSession & { confirmCode: string }) | undefined;
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  async function connect(pairing: boolean) {
    const current = new WebSocket(`${offer.relay}${relayPaths.device}`);
    socket = current;
    session = undefined;
    const start = startHandshake(
      identity,
      macKey,
      pairing ? { offerId: offer.offerId, secret: fromB64(offer.secret), name } : undefined,
    );
    return new Promise<string>((resolve, reject) => {
      current.on("error", reject);
      current.on("close", () => {
        for (const waiter of pending.values()) waiter.reject(new Error("phone_closed"));
        pending.clear();
        reject(new Error("phone_closed"));
      });
      current.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        if (frame.t === "challenge")
          current.send(
            JSON.stringify({
              t: "hello",
              v: 1,
              role: "device",
              publicKey: toB64(identity.publicKey),
              signature: signHello(identity, "device", frame.nonce),
              macId: offer.macId,
              ...(pairing ? { offerId: offer.offerId } : {}),
            }),
          );
        if (frame.t === "ready") current.send(JSON.stringify({ t: "data", payload: start.hello }));
        if (frame.t !== "data") return;
        const payload = frame.payload as Handshake2 | SealedMessage;
        if (payload.t === "hs2") {
          session = start.finish(payload);
          resolve(session.confirmCode);
          return;
        }
        if (payload.t !== "msg" || !session) return;
        const message = JSON.parse(session.open(payload));
        if (message.method === "event") {
          events.push(message.params);
          return;
        }
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
      });
    });
  }
  const confirmCode = await connect(true);
  return {
    id: linkId(identity.publicKey),
    confirmCode,
    events,
    call(method: string, params: unknown = {}, commandId?: string): Promise<unknown> {
      if (!session || socket?.readyState !== WebSocket.OPEN) throw new Error("phone_offline");
      const id = ++next;
      const sealed = session.seal(
        JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(commandId ? { commandId } : {}) }),
      );
      socket.send(JSON.stringify({ t: "data", payload: sealed }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    /** A later connection with the stored keys, as after the app restarts. */
    reconnect: () => connect(false),
    get open() {
      return socket?.readyState === WebSocket.OPEN;
    },
    close() {
      socket?.close();
    },
  };
}
