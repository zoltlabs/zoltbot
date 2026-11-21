// C15: link cards from the Mac. The Mac fetches the page; the phone only shows the card.
import { LINK_PREVIEWS_PER_MESSAGE, linksIn } from "@zoltbot/protocol";

export interface LinkCard {
  url: string;
  title: string;
  siteName: string;
  description?: string;
  /** A data URL for a small PNG, JPEG, GIF or WebP picture. */
  image?: string;
}

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Keeps only the fields a card shows, and only a picture given as image data. */
export function parseLinkCard(value: unknown): LinkCard | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const url = text(row.url);
  const title = text(row.title);
  const siteName = text(row.siteName);
  if (!url || !title || !siteName || !/^https?:\/\//i.test(url)) return null;
  const description = text(row.description);
  const image = text(row.image);
  return {
    url,
    title,
    siteName,
    ...(description ? { description } : {}),
    ...(image && /^data:image\/(png|jpeg|gif|webp);base64,/.test(image) ? { image } : {}),
  };
}

/** The links a message gets cards for: web links only, at most two. */
export const cardLinks = (body: string) => linksIn(body).slice(0, LINK_PREVIEWS_PER_MESSAGE);

const cards = new Map<string, Promise<LinkCard | null>>();

/** A card for one link in a message, or null when the Mac has none. Asked once per app run. */
export function loadLinkCard(
  call: Call,
  target: { threadId: string; itemId: string; url: string },
): Promise<LinkCard | null> {
  const key = `${target.threadId} ${target.itemId} ${target.url}`;
  let card = cards.get(key);
  if (!card) {
    card = call("link.preview", target).then(parseLinkCard, () => null);
    if (cards.size >= 200) cards.delete(cards.keys().next().value as string);
    cards.set(key, card);
  }
  return card;
}
