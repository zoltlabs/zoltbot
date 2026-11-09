import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  answerHandshake,
  createPairingOffer,
  fromB64,
  type Handshake1,
  type Identity,
  pairingOfferTtlMs,
  pairingUrl,
  toB64,
} from "@zoltbot/link";
import { type Device, DeviceSchema, type DomainEvent, parse } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { Answered, RelayLink } from "./relay-link.js";

// Paired phones (D124). Device records are entities with events like the rest; the pairing
// secret lives only in memory for the five minutes the offer lasts.

interface Offer {
  offerId: string;
  secret: Uint8Array;
  expiresAt: number;
}
export interface DeviceOptions {
  store: Store;
  publish(events: DomainEvent[]): void;
  identity(): Promise<Identity>;
  link(): RelayLink | undefined;
  /** Starts the default relay before pairing; it only runs while a phone needs it. */
  wake?(): Promise<void>;
  relayDefault?: string;
  macName?: string;
  now?(): number;
}
const seenEveryMs = 60_000;

export function defaultMacName() {
  const name = hostname()
    .replace(/\.local$/i, "")
    .trim();
  return (name || "Mac").slice(0, 80);
}

export function deviceBook(options: DeviceOptions) {
  const now = () => options.now?.() ?? Date.now();
  let offer: Offer | undefined;
  let starting = false;
  const record = (id: string) => options.store.record("device", id) as Device | undefined;
  const all = () => (options.store.snapshot(["device"]).device ?? []) as Device[];
  function write(device: Device, commandId: string, verb: "created" | "updated") {
    parse(DeviceSchema, device);
    const before = options.store.lastSeq();
    const receipt = options.store.dispatch(
      commandId,
      () => ({
        events: [
          {
            eventId: `${commandId}:0`,
            aggregateType: "device",
            aggregateId: device.id,
            type: `device.${verb}`,
            occurredAt: new Date(now()).toISOString(),
            payload: device,
          },
        ],
        result: device,
      }),
      { items: { ids: [] } },
    );
    const events = options.store.eventsSince(before);
    options.publish(events);
    return { device: receipt.result, events };
  }
  const internalId = (id: string) => `device:${id}:${randomUUID()}`;
  /** A pending phone may not subscribe, so it hears the person's answer directly. */
  const tell = (deviceId: string, events: readonly DomainEvent[]) => {
    for (const event of events)
      options
        .link()
        ?.notify(deviceId, JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }));
  };
  const liveOffer = () => (offer && offer.expiresAt > now() ? offer : undefined);
  const forget = (device: Device): Device => {
    const { confirmCode: _code, ...rest } = device;
    return { ...rest, state: "revoked", publicKey: "", archived: true };
  };

  async function answer(hello: Handshake1, from: string): Promise<Answered | undefined> {
    const identity = await options.identity();
    const at = new Date(now()).toISOString();
    if (hello.offerId) {
      const current = liveOffer();
      if (!current || current.offerId !== hello.offerId) throw new Error("offer_expired");
      const result = answerHandshake(identity, hello, { offerSecret: current.secret });
      if (result.deviceId !== from) throw new Error("device_id_mismatch");
      // One phone per offer: the QR code cannot pair a second device.
      offer = undefined;
      const existing = record(from);
      const publicKey = toB64(result.deviceKey);
      if (!(existing?.state === "paired" && existing.publicKey === publicKey))
        write(
          {
            id: from,
            name: hello.name ?? "iPhone",
            platform: "ios",
            publicKey,
            state: "pending",
            confirmCode: result.confirmCode,
            createdAt: existing?.createdAt ?? at,
            lastSeenAt: at,
            archived: false,
          },
          internalId(from),
          existing ? "updated" : "created",
        );
      return result;
    }
    const device = record(from);
    if (!device || device.state === "revoked" || !device.publicKey) return undefined;
    const result = answerHandshake(identity, hello, { deviceKey: fromB64(device.publicKey) });
    if (result.deviceId !== from) throw new Error("device_id_mismatch");
    seen(from);
    return result;
  }
  function seen(deviceId: string, lastSeenAt?: string) {
    const device = record(deviceId);
    if (!device || device.state === "revoked") return;
    const at = lastSeenAt ?? new Date(now()).toISOString();
    const previous = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    if (!lastSeenAt && Date.parse(at) - previous < seenEveryMs) return;
    if (device.lastSeenAt === at) return;
    write({ ...device, lastSeenAt: at }, internalId(deviceId), "updated");
  }
  function requireLink() {
    const link = options.link();
    if (!link?.url) throw new Error("relay_not_set: add a relay address first");
    if (link.status !== "online") throw new Error("relay_offline: Zoltbot cannot reach the relay");
    return link;
  }

  async function api(
    method: string,
    params: Record<string, unknown>,
    commandId: string | undefined,
  ): Promise<unknown> {
    switch (method) {
      case "device.pair.start": {
        starting = true;
        try {
          await options.wake?.();
        } finally {
          starting = false;
        }
        const link = requireLink();
        const identity = await options.identity();
        const relay = link.url;
        if (!relay) throw new Error("relay_offline: Zoltbot cannot reach the relay");
        const created = createPairingOffer(identity, relay, options.macName ?? defaultMacName());
        const expiresAt = now() + pairingOfferTtlMs;
        offer = { offerId: created.offer.offerId, secret: created.secret, expiresAt };
        const expires = new Date(expiresAt).toISOString();
        link.send({ t: "offer", offerId: created.offer.offerId, expiresAt: expires });
        return {
          url: pairingUrl(created.offer),
          offerId: created.offer.offerId,
          expiresAt: expires,
        };
      }
      case "device.pair.confirm": {
        if (!commandId) throw new Error("command_id_required");
        if (params.confirmed !== true) throw new Error("confirmation_required");
        const id = String(params.id);
        const device = record(id);
        if (!device || device.state !== "pending") {
          const done = options.store.receipt(commandId)?.result;
          if (done) return done;
          throw new Error(`not_found: device ${id}`);
        }
        const link = options.link();
        if (params.allow !== true) {
          const denied = write(forget(device), commandId, "updated");
          tell(id, denied.events);
          link?.drop(id);
          link?.send({ t: "revoke", deviceId: id });
          return denied.device;
        }
        requireLink().send({ t: "allow", deviceId: id });
        const { confirmCode: _code, ...rest } = device;
        const allowed = write(
          { ...rest, state: "paired", pairedAt: new Date(now()).toISOString() },
          commandId,
          "updated",
        );
        tell(id, allowed.events);
        return allowed.device;
      }
      case "device.relay":
        return options.relayDefault ? { defaultUrl: options.relayDefault } : {};
      case "device.list":
        return all()
          .filter((device) => !device.archived)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      case "device.revoke": {
        if (!commandId) throw new Error("command_id_required");
        if (params.confirmed !== true) throw new Error("confirmation_required");
        const id = String(params.id);
        const device = record(id);
        if (!device) throw new Error(`not_found: device ${id}`);
        const link = options.link();
        link?.drop(id);
        // The key is gone at once; the relay hears now, or on the next sign in.
        link?.send({ t: "revoke", deviceId: id });
        if (device.state !== "revoked") write(forget(device), commandId, "updated");
        return { ok: true };
      }
      default:
        return undefined;
    }
  }

  return {
    api,
    answer,
    seen,
    allowed: (deviceId: string) => record(deviceId)?.state === "paired",
    paired: () => all().filter((device) => device.state === "paired"),
    /** A phone is paired, waiting to be allowed, or about to scan a code. */
    wanted: () =>
      starting ||
      Boolean(liveOffer()) ||
      all().some((device) => device.state === "paired" || device.state === "pending"),
    /** After every relay sign in. */
    ready() {
      const link = options.link();
      if (!link) return;
      const current = liveOffer();
      if (current)
        link.send({
          t: "offer",
          offerId: current.offerId,
          expiresAt: new Date(current.expiresAt).toISOString(),
        });
      for (const device of all())
        if (device.state === "revoked") link.send({ t: "revoke", deviceId: device.id });
    },
  };
}
export type DeviceBook = ReturnType<typeof deviceBook>;
