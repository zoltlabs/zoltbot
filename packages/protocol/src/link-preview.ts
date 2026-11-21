// C15: link previews. The Mac fetches a page named in a message and returns a small card.

/** Settings row: false turns link previews off on every device. On by default. */
export const LINK_PREVIEW_SETTING = "links.preview";
/** At most this many cards show under one message. */
export const LINK_PREVIEWS_PER_MESSAGE = 2;

export const linkPreviewsOn = (value: unknown): boolean => value !== false;

/** The http and https URLs in a piece of text, in order, without duplicates or trailing punctuation. */
export function linksIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    try {
      found.add(new URL(url).toString());
    } catch {}
  }
  return [...found];
}
