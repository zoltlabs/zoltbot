// C15: link cards from the daemon, and the setting that turns them off.
import { randomUUID } from "node:crypto";
import { LINK_PREVIEW_SETTING, linkPreviewsOn } from "@zoltbot/protocol";
import { LINK_CHANNELS as C, type LinkCard } from "../shared/links";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "rows" | "call">;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Keeps only the fields a card shows, and only a picture given as an image data URL. */
export function parseLinkCard(value: unknown): LinkCard | null {
  if (!isObject(value)) return null;
  const url = text(value.url);
  const title = text(value.title);
  const siteName = text(value.siteName);
  if (!url || !title || !siteName || !/^https?:\/\//i.test(url)) return null;
  const description = text(value.description);
  const image = text(value.image);
  return {
    url,
    title,
    siteName,
    ...(description ? { description } : {}),
    ...(image && /^data:image\/(png|jpeg|gif|webp);base64,/.test(image) ? { image } : {}),
  };
}

export function linkHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.linksPreview]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid link.");
      try {
        const card = await client.call(
          "link.preview",
          {
            threadId: requireString(input.botId, "botId"),
            itemId: requireString(input.messageId, "messageId"),
            url: requireString(input.url, "url"),
          },
          randomUUID(),
        );
        return parseLinkCard(card);
      } catch {
        // A page that can't be read just has no card.
        return null;
      }
    },
    [C.linksEnabled]: () =>
      linkPreviewsOn(
        client.rows("settings").find((row) => row.key === LINK_PREVIEW_SETTING)?.value,
      ),
    [C.linksSetEnabled]: async (input) => {
      if (typeof input !== "boolean") throw new Error("Invalid setting.");
      try {
        await client.call(
          "settings.set",
          { key: LINK_PREVIEW_SETTING, value: input },
          randomUUID(),
        );
      } catch {
        throw new Error("Couldn’t change link previews. Try again.");
      }
    },
  };
}
