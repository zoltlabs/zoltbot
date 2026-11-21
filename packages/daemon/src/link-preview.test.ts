import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { linkPreviewApi, publicAddress, readPage } from "./link-preview.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
let server: Server;
let base = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    hits++;
    const url = request.url ?? "/";
    if (url === "/page")
      return response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          `<html><head><title>Fallback</title><meta property="og:title" content="Fish &amp; chips">` +
            `<meta property="og:site_name" content="Example"><meta name="description" content="A  short\nline">` +
            `<meta property="og:image" content="/logo.png"></head></html>`,
        );
    if (url === "/logo.png")
      return response.writeHead(200, { "content-type": "image/png" }).end(PNG);
    if (url === "/hop") return response.writeHead(302, { location: "/page" }).end();
    if (url === "/loop") return response.writeHead(302, { location: "/loop" }).end();
    if (url === "/away")
      return response.writeHead(302, { location: "http://private.invalid/page" }).end();
    if (url === "/big")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(Buffer.alloc(600 * 1024, 97));
    if (url === "/json")
      return response.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (url === "/slow") return; // never answers
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://site.test:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

// site.test resolves to this machine for the tests; private.invalid to a private address.
const lookup = async (host: string) =>
  host === "private.invalid"
    ? [{ address: "10.0.0.5", family: 4 }]
    : [{ address: "127.0.0.1", family: 4 }];
const allowed = (address: string) => address === "127.0.0.1";

async function fixture(text: string, settings?: unknown) {
  const f = await forkFixture();
  const source = f.store.record("item", "source-message") ?? {};
  f.put("item", {
    ...source,
    id: "said",
    threadId: "thread",
    kind: "message",
    seq: 95,
    body: { text },
  });
  if (settings !== undefined) f.put("settings", { key: "links.preview", value: settings });
  const api = linkPreviewApi({ store: f.store, lookup, allowed });
  const preview = (url: string, itemId = "said") =>
    api("link.preview", { threadId: "thread", itemId, url }) as Promise<Record<string, string>>;
  return { ...f, preview };
}

it("reads the title, site, description and picture of a page in the message", async () => {
  const f = await fixture(`Look at ${base}/page.`);
  const card = await f.preview(`${base}/page`);
  expect(card).toMatchObject({
    url: `${base}/page`,
    title: "Fish & chips",
    siteName: "Example",
    description: "A short line",
  });
  expect(card.image).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  f.close();
});

it("caches a card, follows a redirect and reports the final address", async () => {
  const f = await fixture(`${base}/hop`);
  const before = hits;
  const card = await f.preview(`${base}/hop`);
  expect(card.url).toBe(`${base}/page`);
  const after = hits;
  await f.preview(`${base}/hop`);
  expect(hits).toBe(after);
  expect(after).toBeGreaterThan(before);
  f.close();
});

it("refuses links that aren't in the message", async () => {
  const f = await fixture(`${base}/page`);
  await expect(f.preview(`${base}/json`)).rejects.toThrow("link_not_in_message");
  await expect(f.preview(`${base}/page`, "missing")).rejects.toThrow("link_not_in_message");
  f.close();
});

it("refuses private addresses, including through a redirect", async () => {
  const f = await fixture(`http://private.invalid/page ${base}/away`);
  await expect(f.preview("http://private.invalid/page")).rejects.toThrow("link_private");
  await expect(f.preview(`${base}/away`)).rejects.toThrow("link_private");
  f.close();
});

it("stops endless redirects, large pages, other content and slow servers", async () => {
  const f = await fixture(`${base}/loop ${base}/big ${base}/json ${base}/slow`);
  await expect(f.preview(`${base}/loop`)).rejects.toThrow("link_redirects");
  await expect(f.preview(`${base}/big`)).rejects.toThrow("link_too_large");
  await expect(f.preview(`${base}/json`)).rejects.toThrow("link_not_page");
  await expect(f.preview(`${base}/slow`)).rejects.toThrow("link_timeout");
  f.close();
}, 10_000);

it("does nothing when previews are off", async () => {
  const f = await fixture(`${base}/page`, false);
  await expect(f.preview(`${base}/page`)).rejects.toThrow("link_previews_off");
  f.close();
});

it("treats loopback, private, link-local and mapped addresses as not public", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not an address",
  ])
    expect(publicAddress(address), address).toBe(false);
  for (const address of ["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"])
    expect(publicAddress(address), address).toBe(true);
});

it("falls back to the page title and host", () => {
  const read = readPage("<title> Plain  page </title>", new URL("https://www.example.com/x"));
  expect(read).toMatchObject({ title: "Plain page", siteName: "example.com", description: "" });
});
