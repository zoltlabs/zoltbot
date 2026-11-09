import { type Static, type TSchema, Type } from "@sinclair/typebox";

// The mobile link contract (D124). Three layers:
// 1. Relay frames: JSON text frames between a client (Mac or phone) and the relay.
// 2. Link messages: the payload of a data frame, end to end between a phone and its Mac.
// 3. Inside a sealed message: the same JSON-RPC 2.0 text the desktop UI sends to zoltd.
// The relay reads layer 1 only. It never sees a link session key.

export const linkVersion = 1;
/** Version 2 uses published Noise IK and never negotiates the private v1 handshake. */
export const linkSessionVersion = 2;
export const relayPaths = { mac: "/v1/mac", device: "/v1/device" } as const;
/** Largest data frame the relay forwards, in bytes of JSON text. */
export const maxFrameBytes = 1_048_576;
/** How long a pairing offer stays valid. */
export const pairingOfferTtlMs = 5 * 60 * 1000;

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const values = <const T extends string>(items: readonly T[]) =>
  Type.Union(items.map((item) => Type.Literal(item)));
/** Unpadded base64url. */
export const B64 = Type.String({ pattern: "^[A-Za-z0-9_-]+$", maxLength: 1_400_000 });
/** A Mac or device id: the first 22 base64url characters of sha256(Ed25519 public key). */
export const LinkId = Type.String({ pattern: "^[A-Za-z0-9_-]{22}$" });
const At = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$" });
const Role = values(["mac", "device"]);

// ---------- layer 1: relay frames ----------

/** Relay → client, first frame on every connection. */
export const ChallengeFrame = object({
  t: Type.Literal("challenge"),
  v: Type.Literal(1),
  nonce: B64,
});
/**
 * Client → relay. `signature` is Ed25519 over helloMessage(role, nonce). A device names the Mac
 * it wants. A device the Mac has not allowed yet must name a live pairing offer in `offerId`;
 * until the Mac allows it, the relay forwards only its data frames to that Mac, and only while
 * the offer lasts.
 */
export const HelloFrame = object({
  t: Type.Literal("hello"),
  v: Type.Literal(1),
  role: Role,
  publicKey: B64,
  signature: B64,
  macId: Type.Optional(LinkId),
  offerId: Type.Optional(LinkId),
});
export const ReadyFrame = object({ t: Type.Literal("ready"), id: LinkId });
export const RelayErrorFrame = object({
  t: Type.Literal("error"),
  code: values([
    "bad_frame",
    "bad_signature",
    "not_allowed",
    "offer_expired",
    "too_large",
    "rate_limited",
    "mac_offline",
  ]),
  message: Type.String(),
});
/** Relay → device when its Mac connects or drops; relay → Mac when a device does. */
export const PresenceFrame = object({
  t: Type.Literal("presence"),
  id: LinkId,
  online: Type.Boolean(),
  lastSeenAt: Type.Optional(At),
});
/** Mac → relay: open a pairing window. */
export const OfferFrame = object({ t: Type.Literal("offer"), offerId: LinkId, expiresAt: At });
/** Mac → relay: the person allowed this device. The relay routes it from now on. */
export const AllowFrame = object({ t: Type.Literal("allow"), deviceId: LinkId });
/** Mac → relay: forget this device, close its connection and drop its push token. */
export const RevokeFrame = object({ t: Type.Literal("revoke"), deviceId: LinkId });
/** Device → relay: where to send pushes. The relay keeps it beside the device record. */
export const PushRegisterFrame = object({
  t: Type.Literal("push.register"),
  platform: values(["apns", "apns-sandbox"]),
  token: Type.String({ minLength: 1, maxLength: 400 }),
});
/** Opaque daemon record id. Never text: an id says nothing about the request it names. */
export const PushRecordId = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
/**
 * Mac → relay: send a push to a device. Pushes carry no content: the app shows a fixed text
 * for the kind and the count, then fetches details over the link. When exactly one simple
 * approval is new, the Mac adds category "approval" with that interaction's id and version so
 * the app can offer Allow once and Reject actions. The action
 * answers through interaction.answer over the sealed link, fenced by the version.
 */
export const PushFrame = object({
  t: Type.Literal("push"),
  deviceId: LinkId,
  kind: values(["needs_you", "task_done"]),
  count: Type.Integer({ minimum: 0, maximum: 999 }),
  category: Type.Optional(values(["approval"])),
  interactionId: Type.Optional(PushRecordId),
  threadId: Type.Optional(PushRecordId),
  version: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
});
/**
 * Forwarded payload. Sender → relay: the Mac sets `to` (a device id), a device leaves both
 * unset. Relay → receiver: the relay sets `from`. `payload` is a LinkMessage.
 */
export const DataFrame = object({
  t: Type.Literal("data"),
  to: Type.Optional(LinkId),
  from: Type.Optional(LinkId),
  payload: Type.Unknown(),
});

export const ClientFrame = Type.Union([
  HelloFrame,
  OfferFrame,
  AllowFrame,
  RevokeFrame,
  PushRegisterFrame,
  PushFrame,
  DataFrame,
]);
export const ServerFrame = Type.Union([
  ChallengeFrame,
  ReadyFrame,
  RelayErrorFrame,
  PresenceFrame,
  DataFrame,
]);
export type ClientFrame = Static<typeof ClientFrame>;
export type ServerFrame = Static<typeof ServerFrame>;

// ---------- layer 2: link messages ----------

/** First Noise IK message. The pairing secret is inside the encrypted Noise payload. */
export const Handshake1 = object({
  t: Type.Literal("hs1"),
  v: Type.Literal(linkSessionVersion),
  noise: Type.String({ pattern: "^[A-Za-z0-9_-]+$", maxLength: 1024 }),
  s: Type.Optional(B64),
  offerId: Type.Optional(LinkId),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});
/** Second Noise IK message authenticates the Mac and completes the session. */
export const Handshake2 = object({
  t: Type.Literal("hs2"),
  v: Type.Literal(linkSessionVersion),
  noise: Type.String({ pattern: "^[A-Za-z0-9_-]+$", maxLength: 1024 }),
});
/** Ordered Noise transport records, framed inside one relay message. */
export const SealedMessage = object({
  t: Type.Literal("msg"),
  v: Type.Literal(linkSessionVersion),
  n: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  c: B64,
});
export const LinkMessage = Type.Union([Handshake1, Handshake2, SealedMessage]);
export type Handshake1 = Static<typeof Handshake1>;
export type Handshake2 = Static<typeof Handshake2>;
export type SealedMessage = Static<typeof SealedMessage>;
export type LinkMessage = Static<typeof LinkMessage>;

// ---------- pairing QR code ----------

/** Carried in the QR code as zoltbot://pair?<query>. See pairingUrl and parsePairingUrl. */
export const PairingOffer = object({
  v: Type.Literal(linkSessionVersion),
  relay: Type.String({
    pattern: "^wss://[^\\s]+$|^ws://(localhost|127\\.0\\.0\\.1)(:\\d+)?(/[^\\s]*)?$",
  }),
  macId: LinkId,
  macKey: B64,
  offerId: LinkId,
  secret: B64,
  name: Type.String({ minLength: 1, maxLength: 80 }),
});
export type PairingOffer = Static<typeof PairingOffer>;
