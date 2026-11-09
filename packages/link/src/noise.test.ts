import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { x25519 } from "@noble/curves/ed25519";
import { buildSync } from "esbuild";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher.js";
import { afterAll, describe, expect, it } from "vitest";
import * as native from "./crypto.js";
import vector from "./fixtures/noise-ik.json" with { type: "json" };

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const temp = mkdtempSync(path.join(tmpdir(), "zoltbot-noise-"));
const outfile = path.join(temp, "portable.mjs");
// Exercise the actual Metro adapter and Uint8Array backend, not Node's native sodium.
buildSync({
  stdin: {
    contents:
      'export * from "./crypto.ts"; export {default as Noise} from "noise-handshake"; export {default as Cipher} from "noise-handshake/cipher.js";',
    resolveDir: root,
  },
  bundle: true,
  platform: "neutral",
  mainFields: ["browser", "main"],
  format: "esm",
  alias: {
    "sodium-universal": path.join(root, "noise-sodium.ts"),
    b4a: path.join(path.dirname(require.resolve("b4a/package")), "browser.js"),
  },
  outfile,
});
const portable = (await import(pathToFileURL(outfile).href)) as typeof native & {
  Noise: typeof Noise;
  Cipher: typeof Cipher;
};
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

for (const [name, Backend, CipherBackend] of [
  ["native sodium", Noise, Cipher],
  ["iPhone portable primitives", portable.Noise, portable.Cipher],
] as const) {
  describe(name, () => {
    it("matches independent Cacophony handshake, transcript and transport vectors", () => {
      const pair = (secret: string) => ({
        publicKey: x25519.getPublicKey(bytes(secret)),
        secretKey: bytes(secret),
      });
      const initiator = new Backend("IK", true, pair(vector.init_static));
      const responder = new Backend("IK", false, pair(vector.resp_static));
      initiator.e = pair(vector.init_ephemeral);
      responder.e = pair(vector.resp_ephemeral);
      initiator.initialise(bytes(vector.init_prologue), bytes(vector.init_remote_static));
      responder.initialise(bytes(vector.resp_prologue));
      const [first, second, ...messages] = vector.messages;
      if (!first || !second) throw new Error("missing_vectors");
      expect(hex(initiator.send(bytes(first.payload)))).toBe(first.ciphertext);
      expect(hex(responder.recv(bytes(first.ciphertext)))).toBe(first.payload);
      expect(hex(responder.send(bytes(second.payload)))).toBe(second.ciphertext);
      expect(hex(initiator.recv(bytes(second.ciphertext)))).toBe(second.payload);
      expect(hex(initiator.hash ?? new Uint8Array())).toBe(vector.handshake_hash);
      expect(hex(responder.hash ?? new Uint8Array())).toBe(vector.handshake_hash);
      if (!initiator.tx || !initiator.rx || !responder.tx || !responder.rx)
        throw new Error("missing_transport_keys");
      const tx = [new CipherBackend(initiator.tx), new CipherBackend(responder.tx)];
      const rx = [new CipherBackend(responder.rx), new CipherBackend(initiator.rx)];
      for (const [i, message] of messages.entries()) {
        const sender = tx[i % 2];
        const receiver = rx[i % 2];
        if (!sender || !receiver) throw new Error("missing_cipher");
        expect(hex(sender.encrypt(bytes(message.payload)))).toBe(message.ciphertext);
        expect(hex(receiver.decrypt(bytes(message.ciphertext)))).toBe(message.payload);
      }
    });
  });
}

function crossRuntimePair() {
  const mac = native.createIdentity();
  const phone = portable.createIdentity();
  const { offer, secret } = native.createPairingOffer(mac, "wss://relay.example.test", "Mac");
  const start = portable.startHandshake(phone, mac.publicKey, {
    offerId: offer.offerId,
    secret,
    name: "Phone",
  });
  const answer = native.answerHandshake(mac, start.hello, { offerSecret: secret });
  return { mac, phone, offer, secret, start, answer, session: start.finish(answer.reply) };
}

describe("phone–Mac Noise interoperability", () => {
  it("pairs, authenticates and reconnects across portable and native runtimes", () => {
    const { mac, phone, answer, session } = crossRuntimePair();
    expect(session.confirmCode).toBe(answer.confirmCode);
    expect(answer.session.open(session.seal("phone → Mac"))).toBe("phone → Mac");
    expect(session.open(answer.session.seal("Mac → phone"))).toBe("Mac → phone");
    const start = portable.startHandshake(phone, mac.publicKey);
    const next = native.answerHandshake(mac, start.hello, { deviceKey: answer.deviceKey });
    expect(next.session.open(start.finish(next.reply).seal("reconnected"))).toBe("reconnected");
    expect(() => next.session.open(session.seal("old session"))).toThrow("bad_message");
  });

  it("carries multi-record attachments and rejects truncation without advancing nonces", () => {
    const { session, answer } = crossRuntimePair();
    const text = "📷".repeat(40_000);
    const message = session.seal(text);
    const encoded = native.fromB64(message.c);
    const firstLength = new DataView(encoded.buffer, encoded.byteOffset, 2).getUint16(0);
    expect(() =>
      answer.session.open({ ...message, c: native.toB64(encoded.subarray(0, firstLength + 2)) }),
    ).toThrow("bad_message");
    const corrupt = encoded.slice();
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
    expect(() => answer.session.open({ ...message, c: native.toB64(corrupt) })).toThrow(
      "bad_message",
    );
    expect(answer.session.open(message)).toBe(text);
    expect(() => answer.session.open(message)).toThrow("replay");
    expect(answer.session.open(session.seal("next"))).toBe("next");
  });

  it("refuses oversized sends before consuming a transport nonce", () => {
    const { session, answer } = crossRuntimePair();
    expect(() => session.seal("x".repeat(native.maxLinkTextBytes + 1))).toThrow("too large");
    expect(answer.session.open(session.seal("still in sync"))).toBe("still in sync");
    const limit = "x".repeat(native.maxLinkTextBytes);
    const message = session.seal(limit);
    expect(JSON.stringify({ t: "data", to: "x".repeat(22), payload: message }).length).toBeLessThan(
      1_048_576,
    );
    expect(answer.session.open(message)).toBe(limit);
  });

  it("binds pairing metadata and rejects changed identities, secrets and protocol versions", () => {
    const { mac, phone, offer, secret } = crossRuntimePair();
    const start = portable.startHandshake(phone, mac.publicKey, {
      offerId: offer.offerId,
      secret,
      name: "Phone",
    });
    for (const change of [
      { name: "Attacker" },
      { offerId: native.randomId() },
      { s: native.toB64(native.createIdentity().publicKey) },
    ])
      expect(() =>
        native.answerHandshake(mac, { ...start.hello, ...change }, { offerSecret: secret }),
      ).toThrow("bad_proof");
    expect(() =>
      native.answerHandshake(mac, start.hello, { offerSecret: new Uint8Array(32) }),
    ).toThrow("bad_proof");
    expect(() =>
      native.answerHandshake(mac, { ...start.hello, v: 1 } as never, { offerSecret: secret }),
    ).toThrow("unsupported_version");
    const answer = native.answerHandshake(mac, start.hello, { offerSecret: secret });
    const session = start.finish(answer.reply);
    expect(() => start.finish(answer.reply)).toThrow("bad_key");
    expect(() => answer.session.open({ ...session.seal("v2"), v: 1 } as never)).toThrow(
      "unsupported_version",
    );
  });
});
