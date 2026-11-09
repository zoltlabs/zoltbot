import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  answerHandshake,
  ClientFrame,
  createIdentity,
  createPairingOffer,
  fromB64,
  LinkError,
  LinkMessage,
  linkId,
  PairingOffer,
  pairingUrl,
  parsePairingUrl,
  ServerFrame,
  signHello,
  startHandshake,
  toB64,
  verifyHello,
} from "./index.js";

const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "snapshot.get", params: {} });

function pair() {
  const mac = createIdentity(),
    device = createIdentity();
  const { offer, secret } = createPairingOffer(mac, "wss://relay.example.test", "Studio Mac");
  const scanned = Value.Parse(PairingOffer, parsePairingUrl(pairingUrl(offer)));
  const start = startHandshake(device, fromB64(scanned.macKey), {
    offerId: scanned.offerId,
    secret: fromB64(scanned.secret),
    name: "Test iPhone",
  });
  const answer = answerHandshake(mac, start.hello, { offerSecret: secret });
  const phone = start.finish(answer.reply);
  return { mac, device, offer, answer, phone };
}

describe("link encoding", () => {
  it("round trips base64url without padding", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 64]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) % 256);
      expect(fromB64(toB64(bytes))).toEqual(bytes);
    }
    expect(toB64(new TextEncoder().encode("zoltbot?"))).toBe("em9sdGJvdD8");
    expect(() => fromB64("a")).toThrow(LinkError);
  });
  it("derives 22 character ids from public keys", () => {
    const id = linkId(createIdentity().publicKey);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("relay sign in", () => {
  it("accepts the signer's hello and rejects another key or role", () => {
    const mac = createIdentity(),
      other = createIdentity();
    const signature = signHello(mac, "mac", "nonce1");
    expect(verifyHello(toB64(mac.publicKey), "mac", "nonce1", signature)).toBe(true);
    expect(verifyHello(toB64(other.publicKey), "mac", "nonce1", signature)).toBe(false);
    expect(verifyHello(toB64(mac.publicKey), "device", "nonce1", signature)).toBe(false);
    expect(verifyHello(toB64(mac.publicKey), "mac", "nonce2", signature)).toBe(false);
  });
  it("validates frames on both sides of the relay", () => {
    const id = linkId(createIdentity().publicKey);
    const valid: unknown[] = [
      { t: "hello", v: 1, role: "device", publicKey: "abc", signature: "def", macId: id },
      { t: "offer", offerId: id, expiresAt: "2026-11-03T12:05:00.000Z" },
      { t: "allow", deviceId: id },
      { t: "push", deviceId: id, kind: "needs_you", count: 3 },
      { t: "data", to: id, payload: { t: "msg", n: 1, c: "abc" } },
    ];
    for (const frame of valid) expect(Value.Check(ClientFrame, frame)).toBe(true);
    expect(Value.Check(ClientFrame, { t: "push", deviceId: id, kind: "x", count: 1 })).toBe(false);
    const approval = { t: "push", deviceId: id, kind: "needs_you", count: 1, category: "approval" };
    expect(
      Value.Check(ClientFrame, {
        ...approval,
        interactionId: "a1b2:c3",
        threadId: "t",
        version: 1,
      }),
    ).toBe(true);
    for (const extra of [
      { interactionId: "Allow rm -rf /", version: 1 },
      { interactionId: "a", version: 0 },
      { category: "question" },
      { preview: "Private question text" },
    ])
      expect(Value.Check(ClientFrame, { ...approval, ...extra })).toBe(false);
    expect(Value.Check(ClientFrame, { t: "allow", deviceId: id, extra: 1 })).toBe(false);
    expect(Value.Check(ServerFrame, { t: "presence", id, online: false })).toBe(true);
    expect(Value.Check(ServerFrame, { t: "error", code: "mac_offline", message: "" })).toBe(true);
  });
});

describe("pairing and sessions", () => {
  it("pairs from the QR code, shows the same code on both sides and carries JSON-RPC", () => {
    const { device, answer, phone } = pair();
    expect(answer.deviceId).toBe(linkId(device.publicKey));
    expect(phone.confirmCode).toMatch(/^\d{6}$/);
    expect(phone.confirmCode).toBe(answer.confirmCode);
    const sealed = phone.seal(rpc);
    for (const message of [answer.reply, sealed])
      expect(Value.Check(LinkMessage, message)).toBe(true);
    expect(answer.session.open(sealed)).toBe(rpc);
    expect(phone.open(answer.session.seal('{"ok":true}'))).toBe('{"ok":true}');
  });
  it("reconnects a paired device with a fresh session", () => {
    const { mac, device, answer } = pair();
    const start = startHandshake(device, mac.publicKey);
    expect(start.hello.s).toBeUndefined();
    const again = answerHandshake(mac, start.hello, { deviceKey: answer.deviceKey });
    const phone = start.finish(again.reply);
    expect(again.session.open(phone.seal(rpc))).toBe(rpc);
  });
  it("rejects a wrong offer secret, a stranger, a forged Mac, tampering and replays", () => {
    const mac = createIdentity(),
      device = createIdentity(),
      stranger = createIdentity();
    const { offer, secret } = createPairingOffer(mac, "wss://relay.example.test", "Mac");
    const guess = startHandshake(device, mac.publicKey, {
      offerId: offer.offerId,
      secret: new Uint8Array(32),
      name: "Phone",
    });
    expect(() => answerHandshake(mac, guess.hello, { offerSecret: secret })).toThrow("bad_proof");

    // A device that is not the paired one cannot open a session in its place.
    const { answer } = pair();
    const impostor = startHandshake(stranger, mac.publicKey);
    expect(() => answerHandshake(mac, impostor.hello, { deviceKey: answer.deviceKey })).toThrow(
      "bad_key",
    );

    // The proof binds the Mac's key, so a relay holding the secret cannot pair as another Mac.
    const start = startHandshake(device, mac.publicKey, {
      offerId: offer.offerId,
      secret,
      name: "Phone",
    });
    expect(() => answerHandshake(stranger, start.hello, { offerSecret: secret })).toThrow(
      "bad_proof",
    );
    // And a relay answering with its own key instead of the Mac's fails the key check.
    expect(() => start.finish({ t: "hs2", v: 2, noise: toB64(new Uint8Array(48)) })).toThrow(
      "bad_key",
    );

    const { answer: real, phone } = pair();
    const sealed = phone.seal(rpc);
    const bytes = fromB64(sealed.c);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => real.session.open({ ...sealed, c: toB64(bytes) })).toThrow("bad_message");
    expect(real.session.open(sealed)).toBe(rpc);
    expect(() => real.session.open(sealed)).toThrow("replay");
  });
});
