import type { DocumentAnchor } from "./documents";

const CONTEXT = 32;
export const MAX_QUOTE = 300;

/** The anchor for `text.slice(from, to)`: the quote and up to 32 characters around it. */
export function anchorFor(text: string, from: number, to: number): DocumentAnchor {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(text.length, Math.max(from, to), start + MAX_QUOTE);
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

/**
 * Where an anchor's quote is in `text` now, or null when the quote is gone. When the quote occurs
 * more than once, the occurrence whose surroundings match the anchor's context best wins.
 */
export function locateAnchor(
  text: string,
  anchor: DocumentAnchor,
): { from: number; to: number } | null {
  if (!anchor.quote) return null;
  let best: { from: number; score: number } | null = null;
  for (
    let index = text.indexOf(anchor.quote);
    index !== -1;
    index = text.indexOf(anchor.quote, index + 1)
  ) {
    const before = text.slice(Math.max(0, index - anchor.prefix.length), index);
    const after = text.slice(
      index + anchor.quote.length,
      index + anchor.quote.length + anchor.suffix.length,
    );
    const score = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    if (!best || score > best.score) best = { from: index, score };
    if (score === anchor.prefix.length + anchor.suffix.length) break;
  }
  return best ? { from: best.from, to: best.from + anchor.quote.length } : null;
}

function commonPrefix(left: string, right: string): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count++;
  return count;
}

function commonSuffix(left: string, right: string): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  )
    count++;
  return count;
}
