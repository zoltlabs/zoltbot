import { expect, it, vi } from "vitest";
import { LINK_CHANNELS as C } from "../shared/links";
import { linkHandlers, parseLinkCard } from "./links-service";

function client(rows: Record<string, unknown>[] = [], result: unknown = {}) {
  return {
    rows: vi.fn(() => rows),
    call: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

it("asks the daemon for a card and keeps only what the card shows", async () => {
  const daemon = client([], {
    url: "https://example.com/a",
    title: "A page",
    siteName: "Example",
    image: "data:image/png;base64,AAAA",
    extra: "dropped",
  });
  const card = await linkHandlers(daemon)[C.linksPreview]?.({
    botId: "thread",
    messageId: "item",
    url: "https://example.com/a",
  });
  expect(daemon.call).toHaveBeenCalledWith(
    "link.preview",
    { threadId: "thread", itemId: "item", url: "https://example.com/a" },
    expect.any(String),
  );
  expect(card).toEqual({
    url: "https://example.com/a",
    title: "A page",
    siteName: "Example",
    image: "data:image/png;base64,AAAA",
  });
});

it("shows no card when the page can't be read", async () => {
  const handlers = linkHandlers(client([], new Error("link_private")));
  await expect(
    handlers[C.linksPreview]?.({ botId: "t", messageId: "m", url: "http://example.com" }),
  ).resolves.toBeNull();
});

it("drops pictures that aren't image data and cards without a web address", () => {
  expect(
    parseLinkCard({ url: "https://e.com", title: "T", siteName: "S", image: "javascript:x" }),
  ).toEqual({ url: "https://e.com", title: "T", siteName: "S" });
  expect(parseLinkCard({ url: "file:///x", title: "T", siteName: "S" })).toBeNull();
});

it("reads and saves the setting, on by default", async () => {
  const off = client([{ key: "links.preview", value: false }]);
  expect(await linkHandlers(client())[C.linksEnabled]?.(undefined)).toBe(true);
  expect(await linkHandlers(off)[C.linksEnabled]?.(undefined)).toBe(false);
  await linkHandlers(off)[C.linksSetEnabled]?.(true);
  expect(off.call).toHaveBeenCalledWith(
    "settings.set",
    { key: "links.preview", value: true },
    expect.any(String),
  );
});
