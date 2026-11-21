import type { SecretStore } from "./link-store.js";
import type { PairedMac } from "./relay.js";

// The Macs this phone is paired with. They live in one Keychain item with the keys each link
// needs; the phone's identity stays in its own item and is shared by every Mac.

export interface SavedMac extends PairedMac {
  /** What the person calls this Mac on the phone; starts as the Mac's own name. */
  label: string;
  pairedAt: string;
  lastSeenAt?: string;
}
export interface SavedMacs {
  active?: string;
  macs: SavedMac[];
}

const listKey = "zoltbot.link.macs.v2";
const legacyKey = "zoltbot.link.mac.v1";
export const macLimit = 8;
const labelLimit = 60;
/** Written at most this often, so a flaky link does not keep rewriting the Keychain. */
export const seenEveryMs = 60 * 60 * 1000;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
const validMac = (value: unknown): value is PairedMac => {
  const row = value as Partial<PairedMac> | null;
  return !!row && !!text(row.relay) && !!text(row.macId) && !!text(row.macKey);
};

function readSaved(value: unknown, now: string): SavedMac | undefined {
  if (!validMac(value)) return undefined;
  const row = value as Partial<SavedMac>;
  const name = text(row.name);
  return {
    relay: row.relay as string,
    macId: row.macId as string,
    macKey: row.macKey as string,
    name,
    label: cleanLabel(row.label) || name || "Mac",
    pairedAt: text(row.pairedAt) || now,
    ...(text(row.lastSeenAt) ? { lastSeenAt: text(row.lastSeenAt) } : {}),
  };
}

export const cleanLabel = (value: unknown) =>
  text(value).replace(/\s+/g, " ").slice(0, labelLimit).trim();

/** Reads the list, moving a v1 single-Mac entry over the first time. */
export async function loadMacs(store: SecretStore, now = new Date()): Promise<SavedMacs> {
  const stamp = now.toISOString();
  const saved = await store.get(listKey);
  if (saved) {
    try {
      const value = JSON.parse(saved) as { active?: unknown; macs?: unknown };
      const macs = (Array.isArray(value.macs) ? value.macs : [])
        .map((row) => readSaved(row, stamp))
        .filter((row): row is SavedMac => !!row)
        .filter((row, index, all) => all.findIndex((other) => other.macId === row.macId) === index)
        .slice(0, macLimit);
      return withActive({ active: text(value.active), macs });
    } catch {
      return { macs: [] };
    }
  }
  const legacy = await store.get(legacyKey);
  if (!legacy) return { macs: [] };
  let mac: SavedMac | undefined;
  try {
    mac = readSaved(JSON.parse(legacy), stamp);
  } catch {
    mac = undefined;
  }
  if (!mac) return { macs: [] };
  const next = { active: mac.macId, macs: [mac] };
  await saveMacs(store, next);
  await store.remove(legacyKey);
  return next;
}

export const saveMacs = (store: SecretStore, value: SavedMacs) =>
  store.set(listKey, JSON.stringify(withActive(value)));

/** Keeps `active` pointing at a listed Mac, falling back to the first. */
export function withActive(value: SavedMacs): SavedMacs {
  const active = value.macs.some((mac) => mac.macId === value.active)
    ? value.active
    : value.macs[0]?.macId;
  return active ? { active, macs: value.macs } : { macs: value.macs };
}

/** Adds a newly paired Mac, or refreshes the keys of one paired before (its label stays). */
export function addMac(value: SavedMacs, mac: PairedMac, now = new Date()): SavedMacs {
  const prior = value.macs.find((row) => row.macId === mac.macId);
  if (!prior && value.macs.length >= macLimit) throw new Error("mac_limit");
  const row: SavedMac = {
    relay: mac.relay,
    macId: mac.macId,
    macKey: mac.macKey,
    name: mac.name,
    label: prior?.label ?? (cleanLabel(mac.name) || "Mac"),
    pairedAt: now.toISOString(),
    ...(prior?.lastSeenAt ? { lastSeenAt: prior.lastSeenAt } : {}),
  };
  return {
    active: mac.macId,
    macs: prior
      ? value.macs.map((other) => (other.macId === mac.macId ? row : other))
      : [...value.macs, row],
  };
}

export function renameMac(value: SavedMacs, macId: string, label: string): SavedMacs {
  const clean = cleanLabel(label);
  if (!clean) return value;
  return {
    ...value,
    macs: value.macs.map((row) => (row.macId === macId ? { ...row, label: clean } : row)),
  };
}

export function removeMac(value: SavedMacs, macId: string): SavedMacs {
  return withActive({
    ...(value.active === macId ? {} : { active: value.active }),
    macs: value.macs.filter((row) => row.macId !== macId),
  });
}

export function chooseMac(value: SavedMacs, macId: string): SavedMacs {
  return value.macs.some((row) => row.macId === macId) ? { ...value, active: macId } : value;
}

/** Marks a Mac seen; returns undefined when the last mark is recent enough to skip a write. */
export function seenMac(value: SavedMacs, macId: string, now = new Date()): SavedMacs | undefined {
  const row = value.macs.find((mac) => mac.macId === macId);
  if (!row) return undefined;
  const last = row.lastSeenAt ? Date.parse(row.lastSeenAt) : Number.NaN;
  if (Number.isFinite(last) && now.getTime() - last < seenEveryMs) return undefined;
  const stamp = now.toISOString();
  return {
    ...value,
    macs: value.macs.map((mac) => (mac.macId === macId ? { ...mac, lastSeenAt: stamp } : mac)),
  };
}
