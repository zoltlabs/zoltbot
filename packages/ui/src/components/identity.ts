import { createContext, useContext } from "react";

export const avatarHues = 8;

function fnv(text: string) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return hash >>> 0;
}

/** Stable hue 1..8 for a profile id, so a profile keeps its color across renames. */
export function avatarHue(id: string) {
  return (fnv(id) % avatarHues) + 1;
}

/**
 * Hues for a known set of profiles, spread so no two share a hue until all eight are used.
 * Profiles are taken oldest first and each keeps its own hash hue when it is free, so adding
 * a profile never recolors an older one. Pass archived profiles too, so archiving keeps colors.
 */
export function assignHues(profiles: readonly { id: string; createdAt?: string | undefined }[]) {
  // Oldest first; profiles without a creation time come last, in id order.
  const ordered = [...profiles].sort(
    (a, b) =>
      Number(a.createdAt === undefined) - Number(b.createdAt === undefined) ||
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
      a.id.localeCompare(b.id),
  );
  const hues = new Map<string, number>();
  let taken = new Set<number>();
  for (const { id } of ordered) {
    if (hues.has(id)) continue;
    if (taken.size === avatarHues) taken = new Set();
    let hue = avatarHue(id);
    while (taken.has(hue)) hue = (hue % avatarHues) + 1;
    taken.add(hue);
    hues.set(id, hue);
  }
  return hues;
}

/** Profile id to hue for the profiles the app knows; Avatar falls back to the hash. */
export const ProfileHues = createContext<ReadonlyMap<string, number>>(new Map());
export function useProfileHue(id: string | undefined) {
  const hues = useContext(ProfileHues);
  return id === undefined ? undefined : hues.get(id);
}

export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toUpperCase();
}
