// C15: link.preview fetches a page from a link in a chat and returns its title, site name and a
// small picture for a card under the message. Only public addresses are reached: every address a
// name resolves to is checked, the connection is pinned to the checked address, and each redirect
// (at most 3) is checked again. 3 seconds, 512 KB, no cookies, cached for 24 hours.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { LINK_PREVIEW_SETTING, linkPreviewsOn, linksIn } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export const LINK_PREVIEW_TIMEOUT_MS = 3000;
export const LINK_PREVIEW_MAX_BYTES = 512 * 1024;
export const LINK_PREVIEW_MAX_REDIRECTS = 3;
export const LINK_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
/** Pictures larger than this are left out so the card fits one phone link frame. */
export const LINK_PREVIEW_IMAGE_BYTES = 200 * 1024;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** Whether an address is on the public internet (not loopback, private, link-local or reserved). */
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return publicAddress(mapped);
  return !blocked.check(address, "ipv6");
}

export interface LinkCard {
  url: string;
  title: string;
  siteName: string;
  description?: string;
  /** A data URL for a PNG, JPEG, GIF or WebP picture under 200 KB. */
  image?: string;
}

interface FetchOptions {
  allowed(address: string): boolean;
  lookup(host: string): Promise<{ address: string; family: number }[]>;
  accept: string;
  deadline: number;
}

interface Fetched {
  url: URL;
  type: string;
  body: Buffer;
}

function fail(code: string): never {
  throw new Error(code);
}

async function resolveChecked(host: string, options: FetchOptions) {
  const literal = host.replace(/^\[|\]$/g, "");
  const addresses = isIP(literal)
    ? [{ address: literal, family: isIP(literal) }]
    : await options.lookup(host).catch(() => fail("link_unreachable"));
  if (!addresses.length) fail("link_unreachable");
  // Every answer must be public, so a name can't mix a public and a private address.
  if (addresses.some((entry) => !options.allowed(entry.address))) fail("link_private");
  return addresses[0] as { address: string; family: number };
}

function once(url: URL, options: FetchOptions, pinned: { address: string; family: number }) {
  return new Promise<{ status: number; location?: string; type: string; body: Buffer }>(
    (resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const left = options.deadline - Date.now();
      if (left <= 0) return reject(new Error("link_timeout"));
      const request = client.request(
        url,
        {
          method: "GET",
          headers: {
            accept: options.accept,
            "user-agent": "Zoltbot link preview",
            "accept-encoding": "identity",
          },
          // Connect to the address that was checked, never a fresh answer from DNS.
          lookup: ((_host: string, opts: { all?: boolean }, done: (...args: unknown[]) => void) =>
            opts?.all
              ? done(null, [{ address: pinned.address, family: pinned.family }])
              : done(null, pinned.address, pinned.family)) as never,
          agent: false,
          timeout: left,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const type = String(response.headers["content-type"] ?? "");
          const location = response.headers.location;
          if (status >= 300 && status < 400) {
            response.resume();
            return resolve({
              status,
              ...(location ? { location } : {}),
              type,
              body: Buffer.alloc(0),
            });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > LINK_PREVIEW_MAX_BYTES) {
              request.destroy(new Error("link_too_large"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => resolve({ status, type, body: Buffer.concat(chunks) }));
          response.on("error", reject);
        },
      );
      const timer = setTimeout(() => request.destroy(new Error("link_timeout")), left);
      request.on("close", () => clearTimeout(timer));
      request.on("timeout", () => request.destroy(new Error("link_timeout")));
      request.on("error", (error) =>
        reject(
          /^link_/.test(error.message) ? error : new Error("link_unreachable", { cause: error }),
        ),
      );
      request.end();
    },
  );
}

/** Fetches a URL, following at most 3 redirects, each checked before it is followed. */
export async function fetchChecked(raw: string, options: FetchOptions): Promise<Fetched> {
  let url = new URL(raw);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") fail("link_unsupported");
    if (url.username || url.password) fail("link_unsupported");
    const pinned = await resolveChecked(url.hostname, options);
    const result = await once(url, options, pinned);
    if (result.status >= 300 && result.status < 400) {
      if (!result.location || hop >= LINK_PREVIEW_MAX_REDIRECTS) fail("link_redirects");
      url = new URL(result.location, url);
      continue;
    }
    if (result.status < 200 || result.status >= 300) fail("link_unreachable");
    return { url, type: result.type.toLowerCase(), body: result.body };
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === "#") {
        const value =
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        return Number.isFinite(value) && value > 0 && value < 0x110000
          ? String.fromCodePoint(value)
          : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

/** Reads Open Graph tags and the page title from the start of an HTML page. */
export function readPage(html: string, base: URL) {
  const head = html.slice(0, LINK_PREVIEW_MAX_BYTES);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attribute(tag, "property") ?? attribute(tag, "name"))?.toLowerCase();
    const content = attribute(tag, "content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decode(content));
  }
  const title = decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  const rawImage = meta.get("og:image") ?? meta.get("twitter:image");
  let image: URL | undefined;
  try {
    image = rawImage ? new URL(rawImage, base) : undefined;
  } catch {
    image = undefined;
  }
  return {
    title: (meta.get("og:title") ?? title).slice(0, 300),
    siteName: (meta.get("og:site_name") ?? base.hostname.replace(/^www\./, "")).slice(0, 100),
    description: (meta.get("og:description") ?? meta.get("description") ?? "").slice(0, 300),
    image,
  };
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Row = Record<string, unknown>;

function itemText(item: Row | undefined): string {
  const body = (item?.body ?? {}) as Row;
  if (typeof body.text === "string") return body.text;
  const input = Array.isArray(body.input) ? (body.input as Row[]) : [];
  return input
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

export interface LinkPreviewOptions {
  store: Store;
  now?: () => number;
  lookup?: FetchOptions["lookup"];
  /** Tests only: replaces the public-address check. */
  allowed?: (address: string) => boolean;
}

export function linkPreviewApi(options: LinkPreviewOptions) {
  const cache = new Map<string, { at: number; card: LinkCard }>();
  const now = options.now ?? Date.now;
  const lookup =
    options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const allowed = options.allowed ?? publicAddress;
  async function preview(url: string): Promise<LinkCard> {
    const hit = cache.get(url);
    if (hit && now() - hit.at < LINK_PREVIEW_TTL_MS) return hit.card;
    const deadline = Date.now() + LINK_PREVIEW_TIMEOUT_MS;
    const page = await fetchChecked(url, {
      allowed,
      lookup,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      deadline,
    });
    if (!/html|xml/.test(page.type)) fail("link_not_page");
    const read = readPage(page.body.toString("utf8"), page.url);
    let image: string | undefined;
    if (read.image) {
      try {
        const picture = await fetchChecked(read.image.toString(), {
          allowed,
          lookup,
          accept: IMAGE_TYPES.join(","),
          deadline,
        });
        const type = picture.type.split(";")[0]?.trim() ?? "";
        if (IMAGE_TYPES.includes(type) && picture.body.length <= LINK_PREVIEW_IMAGE_BYTES)
          image = `data:${type};base64,${picture.body.toString("base64")}`;
      } catch {
        // The card still shows without a picture.
      }
    }
    const card: LinkCard = {
      url: page.url.toString(),
      title: read.title || page.url.hostname,
      siteName: read.siteName,
      ...(read.description ? { description: read.description } : {}),
      ...(image ? { image } : {}),
    };
    cache.delete(url);
    if (cache.size >= 500) cache.delete(cache.keys().next().value as string);
    cache.set(url, { at: now(), card });
    return card;
  }
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method !== "link.preview") return undefined;
    if (!linkPreviewsOn(options.store.record("settings", LINK_PREVIEW_SETTING)?.value))
      fail("link_previews_off");
    const item = options.store.record("item", String(params.itemId));
    if (!item || item.threadId !== params.threadId) fail("link_not_in_message");
    let url: string;
    try {
      url = new URL(String(params.url)).toString();
    } catch {
      fail("link_unsupported");
    }
    // Only links that appear in the message: the Mac never becomes a general fetcher.
    if (!linksIn(itemText(item)).includes(url)) fail("link_not_in_message");
    return preview(url);
  };
}
