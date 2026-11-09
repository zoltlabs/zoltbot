import {
  answerHandshake,
  createIdentity,
  createPairingOffer,
  fromB64,
  type Handshake1,
  type Handshake2,
  linkId,
  maxFrameBytes,
  relayPaths,
  type SealedMessage,
  signHello,
  startHandshake,
  toB64,
} from "@zoltbot/link";
import { afterEach, describe, expect, it } from "vitest";
import { FakePush } from "./push.js";
import { closeCodes, type Relay } from "./server.js";
import { Client, hello, signIn, startRelay } from "./testing.js";

let relay: Relay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function start(options: Parameters<typeof startRelay>[0] = {}) {
  const started = await startRelay(options);
  relay = started.relay;
  return started;
}
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("sign in", () => {
  it("sends a challenge first and answers a good hello with the derived id", async () => {
    const { url } = await start();
    const mac = await signIn(url, "mac");
    expect(mac.id).toBe(linkId(mac.identity.publicKey));
  });

  it("tells a Mac, and only a Mac, which pushes it delivers", async () => {
    const { url, registry } = await start();
    const mac = await signIn(url, "mac");
    expect(await mac.client.next("features")).toEqual({
      t: "features",
      push: ["needs_you", "task_done", "zolt"],
    });
    const phone = createIdentity();
    await registry.allowDevice(mac.id, linkId(phone.publicKey));
    const device = await signIn(url, "device", { identity: phone, macId: mac.id });
    await new Promise((r) => setTimeout(r, 50));
    expect(device.client.received.some((frame) => frame.t === "features")).toBe(false);
  });

  it("refuses a signature over the wrong nonce", async () => {
    const { url } = await start();
    const client = await Client.open(`${url}${relayPaths.mac}`);
    await client.next("challenge");
    const identity = createIdentity();
    client.send({
      t: "hello",
      v: 1,
      role: "mac",
      publicKey: toB64(identity.publicKey),
      signature: signHello(identity, "mac", "AAAAAAAA"),
    });
    expect((await client.next("error")).code).toBe("bad_signature");
    expect((await client.closed).code).toBe(closeCodes.badSignature);
  });

  it("refuses a key that did not sign", async () => {
    const { url } = await start();
    const other = createIdentity();
    const client = await Client.open(`${url}${relayPaths.mac}`);
    const { nonce } = await client.next("challenge");
    client.send({
      t: "hello",
      v: 1,
      role: "mac",
      publicKey: toB64(createIdentity().publicKey),
      signature: signHello(other, "mac", nonce),
    });
    expect((await client.next("error")).code).toBe("bad_signature");
  });

  it("refuses a role that does not match the path, and frames before hello", async () => {
    const { url } = await start();
    const wrong = await Client.open(`${url}${relayPaths.device}`);
    const { nonce } = await wrong.next("challenge");
    const identity = createIdentity();
    wrong.send({
      t: "hello",
      v: 1,
      role: "mac",
      publicKey: toB64(identity.publicKey),
      signature: signHello(identity, "mac", nonce),
    });
    expect((await wrong.next("error")).code).toBe("bad_frame");
    expect((await wrong.closed).code).toBe(closeCodes.badFrame);

    const early = await Client.open(`${url}${relayPaths.mac}`);
    early.send({ t: "allow", deviceId: linkId(identity.publicKey) });
    expect((await early.next("error")).code).toBe("bad_frame");
    expect((await early.closed).code).toBe(closeCodes.badFrame);
  });

  it("closes a socket that never says hello", async () => {
    const { url } = await start({ limits: { helloTimeoutMs: 50 } });
    const client = await Client.open(`${url}${relayPaths.mac}`);
    expect((await client.closed).code).toBe(closeCodes.timeout);
  });

  it("refuses a device its Mac never allowed", async () => {
    const { url } = await start();
    const mac = await signIn(url, "mac");
    const device = await hello(url, "device", { macId: mac.id });
    expect((await device.client.next("error")).code).toBe("not_allowed");
    expect((await device.client.closed).code).toBe(closeCodes.notAllowed);
  });

  it("lets a new Mac connection replace the old one", async () => {
    const { url } = await start();
    const identity = createIdentity();
    const first = await signIn(url, "mac", { identity });
    await signIn(url, "mac", { identity });
    expect((await first.client.closed).code).toBe(closeCodes.replaced);
  });
});

describe("routing", () => {
  it("routes between a Mac and two allowed devices and reports presence", async () => {
    const { url, registry } = await start();
    const macIdentity = createIdentity();
    const macId = linkId(macIdentity.publicKey);
    const a = createIdentity();
    const b = createIdentity();
    await registry.allowDevice(macId, linkId(a.publicKey));
    await registry.allowDevice(macId, linkId(b.publicKey));

    const phoneA = await signIn(url, "device", { identity: a, macId });
    expect(await phoneA.client.next("presence")).toEqual({
      t: "presence",
      id: macId,
      online: false,
    });

    const mac = await signIn(url, "mac", { identity: macIdentity });
    expect(await mac.client.next("presence")).toEqual({
      t: "presence",
      id: phoneA.id,
      online: true,
    });
    expect(await phoneA.client.next("presence")).toEqual({
      t: "presence",
      id: macId,
      online: true,
    });

    const phoneB = await signIn(url, "device", { identity: b, macId });
    expect(await phoneB.client.next("presence")).toEqual({
      t: "presence",
      id: macId,
      online: true,
    });
    expect(await mac.client.next("presence")).toEqual({
      t: "presence",
      id: phoneB.id,
      online: true,
    });

    mac.client.send({ t: "data", to: phoneA.id, payload: { n: 1 } });
    expect(await phoneA.client.next("data")).toEqual({ t: "data", from: macId, payload: { n: 1 } });
    expect(await phoneB.client.quiet("data")).toBe(true);

    phoneB.client.send({ t: "data", payload: "from b" });
    phoneA.client.send({ t: "data", payload: "from a" });
    const first = await mac.client.next("data");
    const second = await mac.client.next("data");
    expect([first, second]).toEqual(
      expect.arrayContaining([
        { t: "data", from: phoneA.id, payload: "from a" },
        { t: "data", from: phoneB.id, payload: "from b" },
      ]),
    );

    phoneA.client.close();
    const gone = await mac.client.next("presence");
    expect(gone).toMatchObject({ t: "presence", id: phoneA.id, online: false });
    expect(gone.lastSeenAt).toMatch(/Z$/);

    mac.client.close();
    expect(await phoneB.client.next("presence")).toMatchObject({ id: macId, online: false });
    phoneB.client.send({ t: "data", payload: "anyone?" });
    expect((await phoneB.client.next("error")).code).toBe("mac_offline");
  });

  it("refuses data with the wrong addressing", async () => {
    const { url, registry } = await start();
    const mac = await signIn(url, "mac");
    const phone = createIdentity();
    await registry.allowDevice(mac.id, linkId(phone.publicKey));
    const device = await signIn(url, "device", { identity: phone, macId: mac.id });
    mac.client.send({ t: "data", payload: 1 });
    expect((await mac.client.next("error")).code).toBe("bad_frame");
    device.client.send({ t: "data", to: mac.id, payload: 1 });
    expect((await device.client.next("error")).code).toBe("bad_frame");
    device.client.send({ t: "offer", offerId: mac.id, expiresAt: later(1000) });
    expect((await device.client.next("error")).code).toBe("not_allowed");
  });
});

describe("pairing offers", () => {
  it("forwards a pending device only while its offer lasts", async () => {
    const { url, registry } = await start();
    const mac = await signIn(url, "mac");
    const offerId = linkId(createIdentity().publicKey);
    mac.client.send({ t: "offer", offerId, expiresAt: later(400) });
    await expect.poll(() => registry.getOffer(offerId)).toBeDefined();

    const phone = await signIn(url, "device", { macId: mac.id, offerId });
    phone.client.send({ t: "data", payload: "hs1" });
    expect(await mac.client.next("data")).toEqual({ t: "data", from: phone.id, payload: "hs1" });
    mac.client.send({ t: "data", to: phone.id, payload: "hs2" });
    expect((await phone.client.next("data")).payload).toBe("hs2");

    expect((await phone.client.next("error", 1000)).code).toBe("offer_expired");
    expect((await phone.client.closed).code).toBe(closeCodes.timeout);

    const late = await hello(url, "device", { macId: mac.id, offerId });
    expect((await late.client.next("error")).code).toBe("offer_expired");
  });

  it("refuses an offer named for a different Mac, and caps the tries per offer", async () => {
    const { url } = await start({ limits: { offerAttempts: 1 } });
    const mac = await signIn(url, "mac");
    const other = await signIn(url, "mac");
    const offerId = linkId(createIdentity().publicKey);
    mac.client.send({ t: "offer", offerId, expiresAt: later(60_000) });
    await new Promise((r) => setTimeout(r, 50));

    const wrong = await hello(url, "device", { macId: other.id, offerId });
    expect((await wrong.client.next("error")).code).toBe("offer_expired");

    await signIn(url, "device", { macId: mac.id, offerId });
    const third = await hello(url, "device", { macId: mac.id, offerId });
    expect((await third.client.next("error")).code).toBe("rate_limited");
  });

  it("keeps an allowed device after the offer ends", async () => {
    const { url, registry } = await start();
    const mac = await signIn(url, "mac");
    const offerId = linkId(createIdentity().publicKey);
    mac.client.send({ t: "offer", offerId, expiresAt: later(300) });
    await new Promise((r) => setTimeout(r, 50));
    const phone = await signIn(url, "device", { macId: mac.id, offerId });
    mac.client.send({ t: "allow", deviceId: phone.id });
    expect(await mac.client.next("presence")).toEqual({
      t: "presence",
      id: phone.id,
      online: true,
    });
    expect((await registry.getDevice(mac.id, phone.id))?.publicKey).toBe(
      toB64(phone.identity.publicKey),
    );
    await new Promise((r) => setTimeout(r, 400));
    phone.client.send({ t: "data", payload: "still here" });
    expect((await mac.client.next("data")).payload).toBe("still here");
  });
});

describe("revoke", () => {
  it("cuts a live device off at once and keeps it out", async () => {
    const { url, registry } = await start();
    const mac = await signIn(url, "mac");
    const identity = createIdentity();
    await registry.allowDevice(mac.id, linkId(identity.publicKey));
    const phone = await signIn(url, "device", { identity, macId: mac.id });
    phone.client.send({ t: "push.register", platform: "apns", token: "abc" });
    await expect
      .poll(async () => (await registry.getDevice(mac.id, phone.id))?.pushToken)
      .toBe("abc");

    mac.client.send({ t: "revoke", deviceId: phone.id });
    expect((await phone.client.next("error")).code).toBe("not_allowed");
    expect((await phone.client.closed).code).toBe(closeCodes.notAllowed);
    await expect
      .poll(async () => (await registry.getDevice(mac.id, phone.id))?.status)
      .toBe("revoked");
    expect((await registry.getDevice(mac.id, phone.id))?.pushToken).toBeUndefined();

    const again = await hello(url, "device", { identity, macId: mac.id });
    expect((await again.client.next("error")).code).toBe("not_allowed");
  });
});

describe("frame checks", () => {
  it("rejects oversize, malformed, unknown and binary frames", async () => {
    const { url } = await start();
    const mac = await signIn(url, "mac");
    mac.client.send({ t: "data", to: mac.id, payload: "x".repeat(maxFrameBytes) });
    expect((await mac.client.next("error")).code).toBe("too_large");
    mac.client.send("{not json");
    expect((await mac.client.next("error")).code).toBe("bad_frame");
    mac.client.send({ t: "data", to: "short", payload: 1 });
    expect((await mac.client.next("error")).code).toBe("bad_frame");
    mac.client.send({ t: "allow", deviceId: mac.id, extra: true });
    expect((await mac.client.next("error")).code).toBe("bad_frame");
    mac.client.ws.send(Buffer.from("{}"), { binary: true });
    expect((await mac.client.next("error")).code).toBe("bad_frame");
    mac.client.send({ t: "push.register", platform: "apns", token: "x" });
    expect((await mac.client.next("error")).code).toBe("not_allowed");
  });

  it("rate limits each connection and closes one that keeps going", async () => {
    const { url } = await start({
      limits: {
        frames: { mac: { perSecond: 1, burst: 3 }, device: { perSecond: 1, burst: 3 } },
        maxStrikes: 3,
      },
    });
    const mac = await signIn(url, "mac");
    for (let i = 0; i < 6; i++) mac.client.send({ t: "data", to: mac.id, payload: i });
    expect((await mac.client.next("error")).code).toBe("rate_limited");
    expect((await mac.client.closed).code).toBe(closeCodes.badFrame);
  });
});

describe("push", () => {
  it("sends through the push sender and forgets a dead token", async () => {
    const { url, registry, push } = await start();
    const mac = await signIn(url, "mac");
    const identity = createIdentity();
    await registry.allowDevice(mac.id, linkId(identity.publicKey));
    const phone = await signIn(url, "device", { identity, macId: mac.id });
    phone.client.send({ t: "push.register", platform: "apns-sandbox", token: "tok" });
    await expect
      .poll(async () => (await registry.getDevice(mac.id, phone.id))?.pushToken)
      .toBe("tok");

    mac.client.send({ t: "push", deviceId: phone.id, kind: "needs_you", count: 3 });
    await expect.poll(() => push.sent.length).toBe(1);
    expect(push.sent[0]).toEqual({
      platform: "apns-sandbox",
      token: "tok",
      kind: "needs_you",
      count: 3,
    });

    mac.client.send({
      t: "push",
      deviceId: phone.id,
      kind: "needs_you",
      count: 1,
      category: "approval",
      interactionId: "request-1",
      threadId: "thread-1",
      version: 2,
    });
    await expect.poll(() => push.sent.length).toBe(2);
    expect(push.sent[1]).toMatchObject({
      count: 1,
      action: {
        category: "approval",
        interactionId: "request-1",
        threadId: "thread-1",
        version: 2,
      },
    });

    // A notice opens the main agent's chat when tapped; it carries the thread id, no text.
    mac.client.send({ t: "push", deviceId: phone.id, kind: "zolt", count: 1, threadId: "chief" });
    await expect.poll(() => push.sent.length).toBe(3);
    expect(push.sent[2]).toMatchObject({ kind: "zolt", count: 1, threadId: "chief" });
    expect(push.sent[2]).not.toHaveProperty("action");

    // A device of another Mac gets nothing.
    const stranger = await signIn(url, "mac");
    stranger.client.send({ t: "push", deviceId: phone.id, kind: "task_done", count: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(push.sent).toHaveLength(3);
  });

  it("drops a token APNs says is gone", async () => {
    const push = new FakePush(() => ({ ok: false, gone: true, reason: "Unregistered" }));
    const { url, registry } = await start({ push });
    const mac = await signIn(url, "mac");
    const identity = createIdentity();
    await registry.allowDevice(mac.id, linkId(identity.publicKey));
    await registry.setPushToken(mac.id, linkId(identity.publicKey), "apns", "old");
    mac.client.send({
      t: "push",
      deviceId: linkId(identity.publicKey),
      kind: "task_done",
      count: 1,
    });
    await expect
      .poll(async () => (await registry.getDevice(mac.id, linkId(identity.publicKey)))?.pushToken)
      .toBeUndefined();
  });

  it("refuses push registration from a pending device", async () => {
    const { url } = await start();
    const mac = await signIn(url, "mac");
    const offerId = linkId(createIdentity().publicKey);
    mac.client.send({ t: "offer", offerId, expiresAt: later(60_000) });
    await new Promise((r) => setTimeout(r, 50));
    const phone = await signIn(url, "device", { macId: mac.id, offerId });
    phone.client.send({ t: "push.register", platform: "apns", token: "t" });
    expect((await phone.client.next("error")).code).toBe("not_allowed");
  });
});

describe("end to end through the relay", () => {
  it("pairs with the real handshake, then reconnects and talks sealed", async () => {
    const { url } = await start();
    const macIdentity = createIdentity();
    const deviceIdentity = createIdentity();
    const { offer, secret } = createPairingOffer(macIdentity, url, "Test Mac");
    const mac = await signIn(url, "mac", { identity: macIdentity });
    mac.client.send({ t: "offer", offerId: offer.offerId, expiresAt: later(60_000) });
    await new Promise((r) => setTimeout(r, 50));

    // Pairing connection.
    const phone = await signIn(url, "device", {
      identity: deviceIdentity,
      macId: offer.macId,
      offerId: offer.offerId,
    });
    const device = startHandshake(deviceIdentity, fromB64(offer.macKey), {
      offerId: offer.offerId,
      secret: fromB64(offer.secret),
      name: "Test iPhone",
    });
    phone.client.send({ t: "data", payload: device.hello });
    const hs1 = await mac.client.next("data");
    expect(hs1.from).toBe(phone.id);
    const answer = answerHandshake(macIdentity, hs1.payload as Handshake1, { offerSecret: secret });
    expect(answer.deviceId).toBe(phone.id);
    mac.client.send({ t: "data", to: phone.id, payload: answer.reply });
    const deviceSession = device.finish((await phone.client.next("data")).payload as Handshake2);
    expect(deviceSession.confirmCode).toBe(answer.confirmCode);
    mac.client.send({ t: "allow", deviceId: answer.deviceId });
    await mac.client.next("presence");
    phone.client.close();
    await mac.client.next("presence");

    // A later connection: no offer, stored keys, fresh session.
    const again = await signIn(url, "device", { identity: deviceIdentity, macId: offer.macId });
    const next = startHandshake(deviceIdentity, macIdentity.publicKey);
    again.client.send({ t: "data", payload: next.hello });
    const reHello = (await mac.client.next("data")).payload as Handshake1;
    const reAnswer = answerHandshake(macIdentity, reHello, { deviceKey: answer.deviceKey });
    mac.client.send({ t: "data", to: again.id, payload: reAnswer.reply });
    const session = next.finish((await again.client.next("data")).payload as Handshake2);

    const request = '{"jsonrpc":"2.0","id":1,"method":"task.list"}';
    again.client.send({ t: "data", payload: session.seal(request) });
    const sealed = (await mac.client.next("data")).payload as SealedMessage;
    expect(JSON.stringify(sealed)).not.toContain("task.list");
    expect(reAnswer.session.open(sealed)).toBe(request);
    mac.client.send({ t: "data", to: again.id, payload: reAnswer.session.seal("pong") });
    expect(session.open((await again.client.next("data")).payload as SealedMessage)).toBe("pong");
  });
});
