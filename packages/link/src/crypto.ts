/// <reference path="./noise-handshake.d.ts" />
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToUtf8, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher.js";
import {
  type Handshake1,
  type Handshake2,
  linkSessionVersion,
  maxFrameBytes,
  type PairingOffer,
  type SealedMessage,
} from "./frames.js";

// Published Noise IK authenticates the Mac pinned by the QR and the phone's stored identity.
// The relay still uses Ed25519; the standard Ed25519-to-X25519 conversion preserves device ids.
export const noiseProtocol = "Noise_IK_25519_ChaChaPoly_BLAKE2b";
const label = "zoltbot-link-v2";

export class LinkError extends Error {
  constructor(
    readonly code: "bad_key" | "bad_proof" | "bad_message" | "replay" | "unsupported_version",
  ) {
    super(code);
  }
}

// ---------- encoding ----------

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function toB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += alphabet[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}
export function fromB64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new LinkError("bad_message");
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0,
    value = 0,
    index = 0;
  for (const char of text) {
    value = (value << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  return out;
}
function same(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ---------- identities and relay sign in ----------

export interface Identity {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}
export function createIdentity(seed?: Uint8Array): Identity {
  const secretKey = seed ?? ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}
export const linkId = (publicKey: Uint8Array) => toB64(sha256(publicKey)).slice(0, 22);
export const randomId = () => toB64(randomBytes(16)).slice(0, 22);
export const helloMessage = (role: "mac" | "device", nonce: string) =>
  utf8ToBytes(`zoltbot-relay-v1\n${role}\n${nonce}`);
export const signHello = (identity: Identity, role: "mac" | "device", nonce: string) =>
  toB64(ed25519.sign(helloMessage(role, nonce), identity.secretKey));
export function verifyHello(
  publicKey: string,
  role: "mac" | "device",
  nonce: string,
  signature: string,
) {
  try {
    return ed25519.verify(fromB64(signature), helloMessage(role, nonce), fromB64(publicKey), {
      zip215: false,
    });
  } catch {
    return false;
  }
}

// ---------- pairing offer ----------

export function createPairingOffer(
  mac: Identity,
  relay: string,
  name: string,
): { offer: PairingOffer; secret: Uint8Array } {
  const secret = randomBytes(32);
  return {
    secret,
    offer: {
      v: linkSessionVersion,
      relay,
      macId: linkId(mac.publicKey),
      macKey: toB64(mac.publicKey),
      offerId: randomId(),
      secret: toB64(secret),
      name,
    },
  };
}
export function pairingUrl(offer: PairingOffer) {
  const query = new URLSearchParams({
    v: String(offer.v),
    r: offer.relay,
    m: offer.macId,
    k: offer.macKey,
    o: offer.offerId,
    s: offer.secret,
    n: offer.name,
  });
  return `zoltbot://pair?${query}`;
}
/** Parses the QR text. Validate the result with PairingOffer before use. */
export function parsePairingUrl(text: string): Record<string, unknown> {
  const prefix = "zoltbot://pair?";
  if (!text.startsWith(prefix)) throw new LinkError("bad_message");
  const query = new URLSearchParams(text.slice(prefix.length));
  return {
    v: Number(query.get("v")),
    relay: query.get("r"),
    macId: query.get("m"),
    macKey: query.get("k"),
    offerId: query.get("o"),
    secret: query.get("s"),
    name: query.get("n"),
  };
}

// ---------- sessions ----------

export interface LinkSession {
  /** Seals one JSON-RPC text for the other side. */
  seal(text: string): SealedMessage;
  /** Opens a sealed message, rejecting forgeries and replays. */
  open(message: SealedMessage): string;
}
// Noise limits each ciphertext record to 65535 bytes. Length-prefix records inside the
// existing relay envelope so attachments can span records without changing the relay API.
const maxRecordPlaintext = 65535 - 16;
// Reserve space for the JSON envelope, record lengths and authentication tags before sealing.
export const maxLinkTextBytes = Math.floor(((maxFrameBytes - 1024) * 3) / 4) - 512;
const maxRecords = Math.ceil((maxLinkTextBytes + 4) / maxRecordPlaintext);
// noise-handshake 4.2 encodes a 32-bit counter. Rekey by reconnecting before it can wrap.
const nonceLimit = 2 ** 32;

function transport(noise: Noise): LinkSession & { confirmCode: string } {
  if (!noise.complete || !noise.tx || !noise.rx || !noise.hash) throw new LinkError("bad_key");
  const send = new Cipher(noise.tx);
  const receive = new Cipher(noise.rx);
  const hash = noise.hash;
  const confirm = new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getUint32(0);
  let sent = 0,
    received = 0;
  return {
    confirmCode: String(confirm % 1_000_000).padStart(6, "0"),
    seal(text) {
      const bytes = utf8ToBytes(text);
      if (bytes.length > maxLinkTextBytes)
        throw new Error(
          "This message is too large. Remove an attachment or choose a smaller photo.",
        );
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, bytes.length);
      const plaintext = concatBytes(length, bytes);
      const count = Math.ceil(plaintext.length / maxRecordPlaintext);
      if (send.nonce + count > nonceLimit || sent >= Number.MAX_SAFE_INTEGER)
        throw new LinkError("bad_key");
      const next = new Cipher(send.key);
      next.setNonce(send.nonce);
      const records: Uint8Array[] = [];
      for (let offset = 0; offset < plaintext.length; offset += maxRecordPlaintext) {
        const record = next.encrypt(plaintext.subarray(offset, offset + maxRecordPlaintext));
        const size = new Uint8Array(2);
        new DataView(size.buffer).setUint16(0, record.length);
        records.push(size, record);
      }
      send.setNonce(next.nonce);
      sent += 1;
      return { t: "msg", v: linkSessionVersion, n: sent, c: toB64(concatBytes(...records)) };
    },
    open(message) {
      if (message.v !== linkSessionVersion) throw new LinkError("unsupported_version");
      if (!Number.isSafeInteger(message.n) || message.n !== received + 1)
        throw new LinkError("replay");
      // A rejected frame must not advance any record nonce, including multi-record messages.
      const next = new Cipher(receive.key);
      next.setNonce(receive.nonce);
      try {
        if (message.c.length > maxFrameBytes) throw new Error("too_large");
        const encoded = fromB64(message.c);
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        const parts: Uint8Array[] = [];
        let offset = 0;
        while (offset < encoded.length) {
          if (parts.length >= maxRecords || next.nonce >= nonceLimit) throw new Error("too_large");
          const size = view.getUint16(offset);
          offset += 2;
          if (size < 16 || offset + size > encoded.length) throw new Error("bad_record");
          parts.push(next.decrypt(encoded.subarray(offset, offset + size)));
          offset += size;
        }
        const plaintext = concatBytes(...parts);
        if (plaintext.length < 4) throw new Error("bad_length");
        const size = new DataView(plaintext.buffer, plaintext.byteOffset, 4).getUint32(0);
        if (size !== plaintext.length - 4 || size > maxLinkTextBytes) throw new Error("bad_length");
        const text = bytesToUtf8(plaintext.subarray(4));
        receive.setNonce(next.nonce);
        received = message.n;
        return text;
      } catch {
        throw new LinkError("bad_message");
      }
    },
  };
}

function staticKeys(identity: Identity) {
  return {
    publicKey: ed25519.utils.toMontgomery(identity.publicKey),
    secretKey: ed25519.utils.toMontgomerySecret(identity.secretKey),
  };
}
// Noise's public prologue binds application metadata to the transcript. The QR secret is
// application data encrypted by Noise, never an input to a private key derivation scheme.
function prologue(macKey: Uint8Array, deviceKey: Uint8Array, hello: Handshake1) {
  return utf8ToBytes(
    JSON.stringify([label, toB64(macKey), toB64(deviceKey), hello.offerId ?? "", hello.name ?? ""]),
  );
}

/** Device side: send the first Noise IK message, then finish with the Mac's response. */
export function startHandshake(
  device: Identity,
  macPublicKey: Uint8Array,
  pairing?: { offerId: string; secret: Uint8Array; name: string },
) {
  const noise = new Noise("IK", true, staticKeys(device));
  const hello: Handshake1 = { t: "hs1", v: linkSessionVersion, noise: "" };
  if (pairing) {
    if (pairing.secret.length !== 32) throw new LinkError("bad_proof");
    hello.s = toB64(device.publicKey);
    hello.offerId = pairing.offerId;
    hello.name = pairing.name;
  }
  noise.initialise(
    prologue(macPublicKey, device.publicKey, hello),
    ed25519.utils.toMontgomery(macPublicKey),
  );
  hello.noise = toB64(noise.send(pairing?.secret ?? new Uint8Array()));
  let finished = false;
  return {
    hello,
    finish(reply: Handshake2): LinkSession & { confirmCode: string } {
      if (reply.v !== linkSessionVersion) throw new LinkError("unsupported_version");
      if (finished) throw new LinkError("bad_key");
      finished = true;
      try {
        if (noise.recv(fromB64(reply.noise)).length !== 0) throw new Error("unexpected_payload");
        return transport(noise);
      } catch {
        throw new LinkError("bad_key");
      }
    },
  };
}

/** Mac side: Noise checks the phone key; its encrypted payload proves possession of the QR. */
export function answerHandshake(
  mac: Identity,
  hello: Handshake1,
  known: { deviceKey: Uint8Array } | { offerSecret: Uint8Array },
) {
  if (hello.v !== linkSessionVersion) throw new LinkError("unsupported_version");
  const pairing = "offerSecret" in known;
  if (pairing && (!hello.s || !hello.offerId)) throw new LinkError("bad_proof");
  if (!pairing && (hello.s || hello.offerId || hello.name)) throw new LinkError("bad_key");
  const deviceKey = pairing ? fromB64(hello.s ?? "") : known.deviceKey;
  const noise = new Noise("IK", false, staticKeys(mac));
  try {
    noise.initialise(prologue(mac.publicKey, deviceKey, hello));
    const payload = noise.recv(fromB64(hello.noise));
    if (!noise.rs || !same(noise.rs, ed25519.utils.toMontgomery(deviceKey)))
      throw new Error("wrong_identity");
    if (
      pairing
        ? known.offerSecret.length !== 32 || !same(payload, known.offerSecret)
        : payload.length !== 0
    )
      throw new Error("wrong_offer");
    const reply: Handshake2 = {
      t: "hs2",
      v: linkSessionVersion,
      noise: toB64(noise.send()),
    };
    const session = transport(noise);
    return {
      reply,
      deviceKey,
      deviceId: linkId(deviceKey),
      session,
      confirmCode: session.confirmCode,
    };
  } catch {
    throw new LinkError(pairing ? "bad_proof" : "bad_key");
  }
}
