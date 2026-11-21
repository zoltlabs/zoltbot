// I3: Telegram pairing. A bot's direct messages are open to anyone who finds it, so the owner
// pairs their own account first: the Mac shows a short code, and sending `/start <code>` to the
// bot from Telegram puts that account on the direct-message route's list.
import { randomInt } from "node:crypto";
import type { BridgeAdapter, InboundMessage } from "@zoltbot/bridges";
import { BRIDGE_DIRECT, type Bridge, type DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { bridgeRows, rowKeys, writeRows } from "./records.js";

export const PAIRING_TTL_MS = 30 * 60 * 1000;
/** No 0/O or 1/I, so the code reads back without mistakes. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const START = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i;
/** One "didn't work" reply a minute per sender, so guessing gets no faster feedback. */
const WRONG_REPLY_MS = 60_000;

export interface Pairing {
  code: string;
  expiresAt: string;
}

const pairingOf = (bridge: Bridge) => bridge.options?.pairing as Pairing | undefined;
const live = (pairing: Pairing | undefined, now = Date.now()) =>
  pairing && Date.parse(pairing.expiresAt) > now ? pairing : undefined;

/** A Telegram bridge always has a live code until someone pairs; saving renews an expired one. */
export function preparePairing(bridge: Bridge): Bridge {
  if (bridge.kind !== "telegram") return bridge;
  const direct = bridge.routes.find((route) => route.from.id === BRIDGE_DIRECT);
  if (!direct || direct.allow.length) {
    const { pairing: _drop, ...rest } = bridge.options ?? {};
    return { ...bridge, options: rest };
  }
  if (live(pairingOf(bridge))) return bridge;
  const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const pairing: Pairing = {
    code,
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
  };
  return { ...bridge, options: { ...bridge.options, pairing } };
}

/**
 * Handles `/start` in a Telegram direct message. The right code pairs the sender; any other
 * `/start` is swallowed, so it never reaches an agent or shows as a refusal worth allowing.
 */
export function pairingHook(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  adapter(id: string): BridgeAdapter | undefined;
  onError?: (code: string) => void;
}) {
  const wrong = new Map<string, number>();
  const reply = (bridge: Bridge, message: InboundMessage, text: string) =>
    host
      .adapter(bridge.id)
      ?.send(message.reply, { text })
      .catch(() => host.onError?.("bridge_pairing_reply_failed"));
  return async (bridge: Bridge, message: InboundMessage) => {
    if (bridge.kind !== "telegram" || !message.place.direct) return false;
    const match = START.exec(message.text.trim());
    if (!match) return false;
    const pairing = live(pairingOf(bridge));
    const direct = bridge.routes.find((route) => route.from.id === BRIDGE_DIRECT);
    const code = (match[1] ?? "").toUpperCase();
    if (!pairing || !direct || code !== pairing.code) {
      const key = `${bridge.id}:${message.sender.id}`;
      const now = Date.now();
      if (code && now - (wrong.get(key) ?? 0) > WRONG_REPLY_MS) {
        wrong.set(key, now);
        if (wrong.size > 500) wrong.delete(wrong.keys().next().value as string);
        await reply(bridge, message, "That code didn’t work. Check it on your Mac.");
      }
      return true;
    }
    const current = bridgeRows(host.store).bridges.get(bridge.id);
    if (!current) return true;
    const { pairing: _used, ...options } = current.options ?? {};
    const next: Bridge = {
      ...current,
      routes: current.routes.map((route) =>
        route.id === direct.id && !route.allow.some((person) => person.id === message.sender.id)
          ? {
              ...route,
              allow: [
                ...route.allow,
                { id: message.sender.id.slice(0, 200), name: message.sender.name.slice(0, 200) },
              ],
            }
          : route,
      ),
      options,
      updatedAt: new Date().toISOString(),
    };
    // The owner may have written before pairing; they no longer show as refused.
    const refused = bridgeRows(host.store).refused.get(bridge.id) ?? [];
    const kept = refused.filter((entry) => entry.person.id !== message.sender.id);
    writeRows(host.store, host.publish, [
      { key: rowKeys.record(bridge.id), value: next },
      ...(kept.length !== refused.length ? [{ key: rowKeys.refused(bridge.id), value: kept }] : []),
    ]);
    await reply(bridge, message, "Paired. Your messages here now go to Zoltbot.");
    return true;
  };
}
