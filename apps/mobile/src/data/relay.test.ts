import { Value } from "@sinclair/typebox/value";
import {
  answerHandshake,
  ClientFrame,
  createIdentity,
  createPairingOffer,
  type Identity,
  type LinkSession,
  linkId,
  pairingUrl,
  toB64,
  verifyHello,
} from "@zoltbot/link";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { deviceIdentity, memoryStore, pairedMac, savePairedMac } from "./link-store.js";
import { type LinkSocket, RelayTransport, readPairingUrl } from "./relay.js";

/**
 * An in-process relay plus a Mac that answers like zoltd: the relay checks hello signatures and
 * forwards data frames; the Mac answers the handshake with answerHandshake and refuses calls with
 * device_not_allowed until allow() is called.
 */
function harness(options: { forge?: boolean; legacy?: boolean } = {}) {
  const mac = createIdentity();
  const { offer, secret } = createPairingOffer(mac, "wss://relay.example.test", "Studio Mac");
  const macId = linkId(mac.publicKey);
  const state = {
    macOnline: true,
    allowed: new Set<string>(),
    keys: new Map<string, Uint8Array>(),
    sessions: new Map<string, LinkSession>(),
    confirmCodes: [] as string[],
    requests: [] as { method: string; commandId?: string }[],
    sockets: [] as LinkSocket[],
    urls: [] as string[],
  };
  const sockets = new Set<{ socket: LinkSocket; deviceId?: string }>();
  const deliver = (socket: LinkSocket, frame: unknown) =>
    setTimeout(() => socket.onmessage?.({ data: JSON.stringify(frame) }), 0);
  const toDevice = (deviceId: string, payload: unknown) => {
    for (const entry of sockets)
      if (entry.deviceId === deviceId) deliver(entry.socket, { t: "data", from: macId, payload });
  };

  function macReceives(deviceId: string, payload: Record<string, unknown>) {
    if (payload.t === "hs1") {
      if (options.legacy) {
        toDevice(deviceId, { t: "hs2", v: 1, e: "abc", ok: "def" });
        return;
      }
      const known = state.keys.get(deviceId);
      // A forged route can return an invalid response, but cannot finish Noise as the pinned Mac.
      if (options.forge) {
        toDevice(deviceId, { t: "hs2", v: 2, noise: toB64(new Uint8Array(48)) });
        return;
      }
      const answer = answerHandshake(
        mac as Identity,
        payload as never,
        known && !payload.offerId ? { deviceKey: known } : { offerSecret: secret },
      );
      state.keys.set(answer.deviceId, answer.deviceKey);
      state.sessions.set(answer.deviceId, answer.session);
      state.confirmCodes.push(answer.confirmCode);
      toDevice(deviceId, answer.reply);
      return;
    }
    const session = state.sessions.get(deviceId);
    if (!session || payload.t !== "msg") return;
    const request = JSON.parse(session.open(payload as never));
    state.requests.push({ method: request.method, commandId: request.commandId });
    const reply = (body: Record<string, unknown>) =>
      toDevice(deviceId, session.seal(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })));
    if (!state.allowed.has(deviceId))
      return reply({ error: { code: -32003, message: "device_not_allowed: allow this phone" } });
    if (request.method === "hello") return reply({ result: { protocolVersion: 1, version: "0" } });
    if (request.method === "events.subscribe")
      return reply({ result: { seq: 5, resync: true, events: [] } });
    if (request.method === "snapshot.get")
      return reply({
        result: { seq: 5, entities: { task: [{ id: "t1", state: "running" }] }, counters: {} },
      });
    return reply({ result: { ok: true } });
  }

  const factory = (url: string): LinkSocket => {
    state.urls.push(url);
    const entry: { socket: LinkSocket; deviceId?: string } = {
      socket: {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(text) {
          const frame = JSON.parse(text);
          expect(Value.Check(ClientFrame, frame)).toBe(true);
          if (frame.t === "hello") {
            if (!verifyHello(frame.publicKey, "device", "nonce-1", frame.signature))
              return deliver(entry.socket, { t: "error", code: "bad_signature", message: "" });
            entry.deviceId = linkId(Buffer.from(frame.publicKey, "base64url"));
            deliver(entry.socket, { t: "ready", id: entry.deviceId });
            if (!state.macOnline)
              deliver(entry.socket, { t: "presence", id: macId, online: false });
            return;
          }
          if (frame.t === "data" && entry.deviceId) {
            if (!state.macOnline)
              return deliver(entry.socket, { t: "error", code: "mac_offline", message: "" });
            const deviceId = entry.deviceId;
            setTimeout(() => macReceives(deviceId, frame.payload), 0);
          }
        },
        close() {
          sockets.delete(entry);
          setTimeout(() => entry.socket.onclose?.(), 0);
        },
      },
    };
    sockets.add(entry);
    state.sockets.push(entry.socket);
    deliver(entry.socket, { t: "challenge", v: 1, nonce: "nonce-1" });
    return entry.socket;
  };

  const presence = (online: boolean) => {
    state.macOnline = online;
    for (const entry of sockets)
      deliver(entry.socket, {
        t: "presence",
        id: macId,
        online,
        ...(online ? {} : { lastSeenAt: "2026-11-03T12:00:00.000Z" }),
      });
  };
  const emit = (deviceId: string, event: Record<string, unknown>) => {
    const session = state.sessions.get(deviceId);
    if (session)
      toDevice(
        deviceId,
        session.seal(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })),
      );
  };
  return { mac, macId, offer, url: pairingUrl(offer), state, factory, presence, emit };
}

describe("relay transport", () => {
  it("reads a pairing link and refuses anything else", () => {
    const { url, offer } = harness();
    const read = readPairingUrl(url);
    expect(read.mac).toEqual({
      relay: offer.relay,
      macId: offer.macId,
      macKey: offer.macKey,
      name: "Studio Mac",
    });
    expect(toB64(read.pairing.secret)).toBe(offer.secret);
    expect(() => readPairingUrl("https://example.test")).toThrow("not a Zoltbot pairing code");
    expect(() => readPairingUrl(url.replace("v=2", "v=1"))).toThrow("Update Zoltbot");
  });

  it("pairs, shows the Mac's confirm code, waits for Allow, then loads the snapshot", async () => {
    const h = harness();
    const keys = memoryStore();
    const identity = await deviceIdentity(keys);
    const deviceId = linkId(identity.publicKey);
    const { mac, pairing } = readPairingUrl(h.url);
    const paired = vi.fn(() => savePairedMac(keys, mac));
    const client = createClient(
      new RelayTransport({
        identity,
        mac,
        pairing: { ...pairing, deviceName: "Test iPhone" },
        socket: h.factory,
        paired,
        pairPollMs: 5,
      }),
    );
    await vi.waitFor(() => expect(client.getState().status).toBe("pairing"));
    expect(h.state.urls[0]).toBe("wss://relay.example.test/v1/device");
    expect(client.getState().confirmCode).toMatch(/^\d{6}$/);
    expect(client.getState().confirmCode).toBe(h.state.confirmCodes[0]);
    await expect(client.getState().call("task.list", {})).rejects.toThrow();

    h.state.allowed.add(deviceId);
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    expect(paired).toHaveBeenCalledOnce();
    expect(await pairedMac(keys)).toEqual(mac);
    expect(client.getState().snapshot.entities.task).toEqual([{ id: "t1", state: "running" }]);
    expect(client.getState().confirmCode).toBeUndefined();

    await expect(
      client.getState().call("turn.send", {
        threadId: "t1",
        input: [{ type: "image", base64: "A".repeat(1_048_576), mimeType: "image/jpeg" }],
        mode: "queue",
      }),
    ).rejects.toThrow("too large");
    expect(h.state.requests.some((request) => request.method === "turn.send")).toBe(false);

    // Calls that change things carry a command id; reads do not.
    await client.getState().call("task.cancel", { id: "t1", confirmed: true });
    const methods = h.state.requests.map((r) => [r.method, Boolean(r.commandId)]);
    expect(methods).toContainEqual(["task.cancel", true]);
    expect(methods).toContainEqual(["snapshot.get", false]);

    h.emit(deviceId, {
      seq: 6,
      eventId: "e6",
      aggregateType: "task",
      aggregateId: "t1",
      type: "task.updated",
      occurredAt: "2026-11-03T12:00:00.000Z",
      payload: { id: "t1", state: "cancelled" },
    });
    await vi.waitFor(() =>
      expect(client.getState().snapshot.entities.task).toEqual([{ id: "t1", state: "cancelled" }]),
    );
    client.stop();
  });

  it("reconnects a paired phone, shows the Mac offline and recovers when it returns", async () => {
    const h = harness();
    const keys = memoryStore();
    const identity = await deviceIdentity(keys);
    const deviceId = linkId(identity.publicKey);
    h.state.keys.set(deviceId, identity.publicKey);
    h.state.allowed.add(deviceId);
    const client = createClient(
      new RelayTransport({ identity, mac: readPairingUrl(h.url).mac, socket: h.factory }),
    );
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    expect(h.state.requests.some((r) => r.method === "hello")).toBe(false);

    h.presence(false);
    await vi.waitFor(() => expect(client.getState().status).toBe("mac_offline"));
    expect(client.getState().lastSeenAt).toBe("2026-11-03T12:00:00.000Z");
    await expect(client.getState().call("task.list", {})).rejects.toThrow("Your Mac is offline.");
    expect(client.getState().snapshot.entities.task).toHaveLength(1);

    h.presence(true);
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    expect(h.state.confirmCodes).toHaveLength(2);
    client.stop();
  });

  it("refuses a relay that answers with a key other than the Mac's", async () => {
    const h = harness();
    const impostor = harness({ forge: true });
    const identity = createIdentity();
    const { pairing } = readPairingUrl(h.url);
    const client = createClient(
      new RelayTransport({
        identity,
        // The QR code names one Mac, but the relay routes to a different one.
        mac: readPairingUrl(h.url).mac,
        pairing: { ...pairing, deviceName: "Phone" },
        socket: impostor.factory,
      }),
    );
    await vi.waitFor(() =>
      expect(client.getState().error).toBe("This is not the Mac you paired with."),
    );
    expect(client.getState().status).toBe("offline");
    client.stop();
  });

  it("reports an old Mac handshake instead of silently downgrading or waiting forever", async () => {
    const h = harness({ legacy: true });
    const { mac, pairing } = readPairingUrl(h.url);
    const client = createClient(
      new RelayTransport({
        identity: createIdentity(),
        mac,
        pairing: { ...pairing, deviceName: "Phone" },
        socket: h.factory,
      }),
    );
    await vi.waitFor(() => expect(client.getState().error).toMatch(/Update Zoltbot/));
    expect(client.getState().status).toBe("offline");
    expect(h.state.requests).toHaveLength(0);
    client.stop();
  });
});
