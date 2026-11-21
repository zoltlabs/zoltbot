import { expect, it, vi } from "vitest";
import { cardLinks, loadLinkCard, parseLinkCard } from "./link-preview";

it("takes the first two web links of a message", () => {
  expect(cardLinks("a https://e.com/1 b https://e.com/2 c https://e.com/3 ftp://e.com")).toEqual([
    "https://e.com/1",
    "https://e.com/2",
  ]);
});

it("asks the Mac once per link and shows nothing when it can't", async () => {
  const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.url === "https://e.com/bad") throw new Error("link_private");
    return { url: params.url, title: "Owls", siteName: "e.com", image: "data:image/png;base64,AA" };
  });
  const target = { threadId: "t", itemId: "i", url: "https://e.com/owls" };
  expect(await loadLinkCard(call, target)).toEqual({
    url: "https://e.com/owls",
    title: "Owls",
    siteName: "e.com",
    image: "data:image/png;base64,AA",
  });
  await loadLinkCard(call, target);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("link.preview", target);
  expect(await loadLinkCard(call, { ...target, url: "https://e.com/bad" })).toBeNull();
});

it("drops pictures that aren't image data and cards without a web address", () => {
  expect(
    parseLinkCard({ url: "https://e.com", title: "T", siteName: "S", image: "file:///x" }),
  ).toEqual({ url: "https://e.com", title: "T", siteName: "S" });
  expect(parseLinkCard({ url: "javascript:alert(1)", title: "T", siteName: "S" })).toBeNull();
});
