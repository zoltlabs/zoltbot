import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import {
  COOKIE_ACCEPT_SETTING,
  consentChoice,
  cookieSettings,
  parseCookieSites,
} from "./consent.js";
import { type EnginePage, playwrightEngine } from "./engine.js";
import { BrowserHost } from "./host.js";
import { browserBinding } from "./runtime.js";

it("keeps the owner's list to host names and matches subdomains", () => {
  expect(parseCookieSites([" https://WWW.Shop.example.test/cart ", "news.example.test"])).toEqual([
    "news.example.test",
    "shop.example.test",
  ]);
  for (const bad of [
    ["not a host"],
    ["com"],
    ["-shop.test"],
    [42],
    "shop.example.test",
    Array(201).fill("a.test"),
  ])
    expect(() => parseCookieSites(bad)).toThrow("invalid_cookie_sites");
  const sites = ["shop.example.test"];
  expect(consentChoice("https://shop.example.test/a", sites)).toBe("accept");
  expect(consentChoice("https://www.shop.example.test/a", sites)).toBe("accept");
  expect(consentChoice("https://eu.shop.example.test/a", sites)).toBe("accept");
  expect(consentChoice("https://notshop.example.test/a", sites)).toBe("reject");
  expect(consentChoice("https://shop.example.test.evil.test/a", sites)).toBe("reject");
  expect(consentChoice("about:blank", sites)).toBe("reject");
});

it("changes the list only through browser.cookies", async () => {
  const f = await runtimeFixture();
  try {
    const cookies = cookieSettings(f.store);
    expect(cookies.sites()).toEqual([]);
    expect(cookies.set("https://www.news.example.test/x", true)).toMatchObject({
      site: "news.example.test",
      sites: ["news.example.test"],
    });
    cookies.set("shop.example.test", true);
    // Rejecting a subdomain removes the listed site that covered it.
    cookies.set("example.test", true);
    expect(cookies.set("eu.example.test", false).sites).toEqual([
      "news.example.test",
      "shop.example.test",
    ]);
    expect(cookies.set("news.example.test", false).sites).toEqual(["shop.example.test"]);
    expect(
      f.store.snapshot(["settings"]).settings?.find((row) => row.key === COOKIE_ACCEPT_SETTING)
        ?.value,
    ).toEqual(["shop.example.test"]);
    expect(() => cookies.set("not a host", true)).toThrow("invalid_cookie_sites");
  } finally {
    f.close();
  }
});

// A real Chromium, when this machine has one Playwright installed earlier.
const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
const shell = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .map((name) =>
        path.join(cache, name, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      )
      .find((file) => existsSync(file))
  : undefined;

// Each button names what it does in the page title, so the test sees which one was clicked.
const mark = (id: string, label: string, did: string, attrs = "") =>
  `<button id="${id}" ${attrs} onclick="document.title='${did}'">${label}</button>`;
const fixed = "position:fixed;bottom:0;left:0;right:0;padding:12px;background:#eee";
const PAGES: Record<string, string> = {
  onetrust: `<div id="onetrust-banner-sdk" style="${fixed}">We use cookies.${mark("onetrust-accept-btn-handler", "Accept All Cookies", "accepted")}${mark("onetrust-reject-all-handler", "Reject All", "rejected")}</div>`,
  cookiebot: `<div id="CybotCookiebotDialog" style="${fixed}">This website uses cookies${mark("CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "Allow all", "accepted")}${mark("CybotCookiebotDialogBodyButtonDecline", "Deny", "rejected")}</div>`,
  didomi: `<div id="didomi-host"><div id="didomi-popup" style="${fixed}">We and our partners use cookies${mark("didomi-notice-agree-button", "Agree and close", "accepted")}${mark("didomi-notice-disagree-button", "Continue without agreeing", "rejected")}</div></div>`,
  usercentrics: `<div id="usercentrics-root"></div><script>document.getElementById('usercentrics-root').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(
    `<div style="${fixed}">Privacy settings${mark("a", "Accept All", "accepted", 'data-testid="uc-accept-all-button"')}${mark("d", "Deny", "rejected", 'data-testid="uc-deny-all-button"')}</div>`,
  ).replace(/</g, "\\u003c")}</script>`,
  german: `<div role="dialog" style="${fixed}">Wir verwenden Cookies, um unsere Website zu verbessern.${mark("a", "Alle akzeptieren", "accepted")}${mark("r", "Alle ablehnen", "rejected")}</div>`,
  late: `<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(
    `<div class="cookie-notice" style="${fixed}">Cookies help us.${mark("a", "Accept", "accepted")}${mark("r", "Only necessary", "rejected")}</div>`,
  )}), 1200)</script>`,
  // A sign-in consent screen is not a cookie banner, even with "consent" in its class.
  oauth: `<div class="oauth-consent-screen" role="dialog" style="${fixed}">Research wants to see your email address.${mark("d", "Deny", "denied access")}${mark("a", "Accept", "granted access")}</div>`,
  // A "Decline" outside any banner, and a banner with no reject or accept button.
  invite: `<h1>Team invite</h1>${mark("d", "Decline", "declined invite")}<div class="cookie-bar" style="${fixed}">We use cookies. <a href="#">Settings</a></div>`,
};

describe.skipIf(!shell)("cookie banners in a real browser", () => {
  let server: Server;
  let frameServer: Server;
  let base = "";
  beforeAll(async () => {
    const listen = async (s: Server) => {
      await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
      return (s.address() as AddressInfo).port;
    };
    // A consent tool's message frame on another origin.
    frameServer = createServer((_, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<button class="sp_choice_type_11" onclick="parent.postMessage('accepted','*')">Accept</button><button class="sp_choice_type_13" title="Reject All" onclick="parent.postMessage('rejected','*')">Reject All</button>`,
      );
    });
    const framePort = await listen(frameServer);
    server = createServer((req, res) => {
      const name = String(req.url).slice(1);
      res.setHeader("content-type", "text/html");
      res.end(
        name === "sourcepoint"
          ? `<script>addEventListener('message', (e) => { document.title = e.data; })</script><iframe id="sp_message_iframe_1" src="http://localhost:${framePort}/consent/message" style="${fixed};height:120px;border:0"></iframe>`
          : `<!doctype html><title>start</title><body><p>Page</p>${PAGES[name] ?? ""}</body>`,
      );
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  afterAll(() => {
    server?.close();
    frameServer?.close();
  });

  async function browse(choose: (url: string) => "reject" | "accept" | "skip") {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-consent-"));
    const browser = await playwrightEngine(root, { executablePath: shell as string }).launch({
      userDataDir: path.join(root, "data"),
      headless: true,
      title: `zb-consent-${Date.now()}`,
      consent: choose,
    });
    const page = browser.pages()[0] as EnginePage;
    return {
      page,
      async open(name: string) {
        await page.evaluate(`location.href = ${JSON.stringify(`${base}/${name}`)}`).catch(() => {});
        await expect.poll(() => page.url()).toBe(`${base}/${name}`);
      },
      title: () => page.evaluate<string>("document.title").catch(() => ""),
      async close() {
        await browser.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it("rejects on the common consent tools, a translated banner, a late one and a cross-origin frame", async () => {
    const asked: string[] = [];
    const b = await browse((url) => {
      asked.push(url);
      return "reject";
    });
    try {
      for (const name of [
        "onetrust",
        "cookiebot",
        "didomi",
        "usercentrics",
        "german",
        "late",
        "sourcepoint",
      ]) {
        await b.open(name);
        await expect.poll(b.title, { timeout: 5000, message: name }).toBe("rejected");
      }
      // The choice is made for the top page's site, even from the consent tool's own frame.
      expect(asked.every((url) => url.startsWith(base))).toBe(true);
    } finally {
      await b.close();
    }
  }, 60_000);

  it("accepts on a listed site, leaves other buttons alone, and waits while the owner has control", async () => {
    let choice: "accept" | "skip" = "accept";
    const b = await browse(() => choice);
    try {
      await b.open("onetrust");
      await expect.poll(b.title, { timeout: 5000 }).toBe("accepted");
      await b.open("oauth");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await b.title()).toBe("start");
      await b.open("invite");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await b.title()).toBe("start");
      choice = "skip";
      await b.open("german");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await b.title()).toBe("start");
    } finally {
      await b.close();
    }
  }, 60_000);

  it("answers through the host from the owner's list and shows the panel what it did", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-consent-host-"));
    const host = new BrowserHost(
      playwrightEngine(root, { executablePath: shell as string }),
      undefined,
      path.join(root, "scratch"),
    );
    host.cookieSites = () => ["127.0.0.1"];
    try {
      mkdirSync(path.join(root, "work"), { recursive: true });
      const binding = browserBinding(
        root,
        path.join(root, "work"),
        { mode: "background" },
        undefined,
        true,
      );
      await host.ensure(binding, "thread");
      const page = host.forThread("thread")?.page as EnginePage;
      await page.evaluate(`location.href = ${JSON.stringify(`${base}/cookiebot`)}`).catch(() => {});
      await expect
        .poll(() => page.evaluate<string>("document.title").catch(() => ""), { timeout: 8000 })
        .toBe("accepted");
      expect(host.view("viewer", "thread", false, () => {})).toMatchObject({
        cookies: { site: "127.0.0.1", accept: true },
      });
      host.control("thread", "card");
      await page.evaluate(`location.href = ${JSON.stringify(`${base}/german`)}`).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await page.evaluate<string>("document.title")).toBe("start");
    } finally {
      await host.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
