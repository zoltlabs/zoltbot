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

// Original silhouettes: each employee keeps the same character across renames and restarts.
const bodies = [
  "M8 7h16v3h4v15h-4v3H8v-3H4V10h4Z",
  "M6 5l7 5h6l7-5v20l-5 3H11l-5-3Z",
  "M12 4h8v4h6v5h3v11h-5v4H8v-4H3V13h3V8h6Z",
  "M11 5h10v3h5v5h3v10h-5v5H8v-5H3V13h3V8h5Z",
  "M5 9h7V5h8v4h7v17H5Z",
  "M10 5h12v4h5v15h-5v4H10v-4H5V9h5Z",
  "M9 3h5v7h4V3h5v7h4v14h-4v4H9v-4H5V10h4Z",
  "M10 4h12v4h4v4h3v13h-5v4h-4v-4h-8v4H8v-4H3V12h3V8h4Z",
];

export function botSilhouette(hue: number, zolt: boolean) {
  return zolt ? "M13 3h9l-3 6h7v16l-5 4H9l-4-4V9h7Z" : bodies[hue - 1];
}
