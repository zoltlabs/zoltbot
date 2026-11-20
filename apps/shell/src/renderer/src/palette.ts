// Matching and ranking for the command palette (S7). Pure functions, so ranking is tested
// without a renderer; CommandPalette.tsx shows the result.

export const PALETTE_GROUPS = [
  "recent",
  "chats",
  "agents",
  "channels",
  "tasks",
  "pages",
  "commands",
] as const;

export type PaletteGroup = Exclude<(typeof PALETTE_GROUPS)[number], "recent">;

export interface PaletteItem {
  /** Stable across updates, such as "chat:<id>", so recents survive a refresh. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** A second line, such as the project name. Matched too, but weighs less. */
  detail?: string;
  run: () => void;
}

export interface PaletteSection {
  group: (typeof PALETTE_GROUPS)[number];
  items: PaletteItem[];
}

/** How many recent items show before anything is typed. */
export const RECENT_SHOWN = 5;
/** How many items each group shows while searching. */
export const GROUP_LIMIT = 8;

/**
 * How well `query` matches `text`, higher is better, or null for no match. A prefix beats a
 * word start, which beats text anywhere, which beats letters in order with gaps.
 */
export function matchScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - Math.min(t.length - q.length, 200);
  const at = t.indexOf(q);
  if (at > 0) {
    const wordStart = /[\s\-_/.:#]/.test(t[at - 1] ?? "");
    return (wordStart ? 800 : 600) - Math.min(at, 100);
  }
  // Letters in order: fewer and shorter gaps score higher; a letter after a space counts extra.
  let score = 400;
  let from = 0;
  let previous = -1;
  for (const letter of q) {
    if (letter === " ") continue;
    const found = t.indexOf(letter, from);
    if (found < 0) return null;
    if (previous >= 0 && found !== previous + 1) score -= Math.min(found - previous, 20);
    if (found === 0 || t[found - 1] === " ") score += 5;
    previous = found;
    from = found + 1;
  }
  return Math.max(score, 1);
}

function itemScore(query: string, item: PaletteItem): number | null {
  const label = matchScore(query, item.label);
  const detail = item.detail ? matchScore(query, item.detail) : null;
  if (label === null && detail === null) return null;
  return Math.max(label ?? 0, detail === null ? 0 : detail / 2);
}

/**
 * Sections to show. With no query: recent items, then every group in order. With a query: each
 * group's matches by score, recent ones first among equals, and groups by their best match.
 */
export function rankPalette(
  items: readonly PaletteItem[],
  query: string,
  recent: readonly string[],
): PaletteSection[] {
  const recentRank = new Map(recent.map((id, index) => [id, index]));
  const byGroup = new Map<PaletteGroup, { item: PaletteItem; score: number }[]>();
  if (!query.trim()) {
    const recentItems = recent
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is PaletteItem => item !== undefined)
      .slice(0, RECENT_SHOWN);
    const shown = new Set(recentItems.map((item) => item.id));
    const sections: PaletteSection[] = recentItems.length
      ? [{ group: "recent", items: recentItems }]
      : [];
    for (const group of PALETTE_GROUPS) {
      if (group === "recent") continue;
      const groupItems = items.filter((item) => item.group === group && !shown.has(item.id));
      if (groupItems.length) sections.push({ group, items: groupItems.slice(0, GROUP_LIMIT) });
    }
    return sections;
  }
  for (const item of items) {
    const score = itemScore(query, item);
    if (score === null) continue;
    const boosted = score + (recentRank.has(item.id) ? 50 - (recentRank.get(item.id) ?? 0) : 0);
    byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), { item, score: boosted }]);
  }
  return [...byGroup.entries()]
    .map(([group, matches]) => {
      matches.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
      return { group, best: matches[0]?.score ?? 0, items: matches.slice(0, GROUP_LIMIT) };
    })
    .sort(
      (a, b) =>
        b.best - a.best || PALETTE_GROUPS.indexOf(a.group) - PALETTE_GROUPS.indexOf(b.group),
    )
    .map(({ group, items: matches }) => ({ group, items: matches.map(({ item }) => item) }));
}

/** Puts `id` first in the recent list, keeping at most `limit`. */
export function rememberRecent(recent: readonly string[], id: string, limit = 20): string[] {
  return [id, ...recent.filter((other) => other !== id)].slice(0, limit);
}
