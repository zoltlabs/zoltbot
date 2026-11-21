// C15: link previews, over IPC. The daemon fetches the page; the renderer shows the card.

export const LINK_CHANNELS = {
  linksPreview: "links:preview",
  linksEnabled: "links:enabled",
  linksSetEnabled: "links:set-enabled",
} as const;

export interface LinkCard {
  url: string;
  title: string;
  siteName: string;
  description?: string;
  /** A data URL for a small PNG, JPEG, GIF or WebP picture. */
  image?: string;
}

export interface LinksDesktopApi {
  /** The card for a link in a message, or null when there is none to show. */
  preview: (input: { botId: string; messageId: string; url: string }) => Promise<LinkCard | null>;
  enabled: () => Promise<boolean>;
  setEnabled: (enabled: boolean) => Promise<void>;
}
