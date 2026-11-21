import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { describe, expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { type BrowserEngine, type EnginePage, playwrightEngine } from "./engine.js";
import { BrowserHost } from "./host.js";
import { type PurchaseDetails, parsePurchase } from "./purchase.js";
import { browserBinding } from "./runtime.js";
import { TAKEOVER_PREFIX, takeoverApi } from "./takeover.js";
import { controlFile, notesFile } from "./takeover-files.js";

it("keeps only a short button name and total from the page", () => {
  expect(parsePurchase({ text: "  Place\n order ", total: "$42.10" })).toEqual({
    text: "Place order",
    total: "$42.10",
  });
  expect(parsePurchase({ text: "" })).toBeUndefined();
  expect(parsePurchase({ text: "x".repeat(200) })?.text).toHaveLength(80);
});

type Answer = (approve: boolean) => Promise<boolean>;
function setup(root: string) {
  let held: ((url: string, details: PurchaseDetails, answer: Answer) => void) | undefined;
  const page: EnginePage = {
    url: () => "https://shop.example.test/checkout",
    frames: async () => async () => {},
    mouse: async () => {},
    key: async () => {},
    evaluate: async <T>() => undefined as T,
    onClose() {},
    onLoad() {},
  };
  const engine: BrowserEngine = {
    async launch(options) {
      held = options.purchase;
      return {
        endpoint: "/tmp/fake.sock",
        pages: () => [page],
        onPage() {},
        onPointer() {},
        async close() {},
      };
    },
  };
  const host = new BrowserHost(engine, undefined, path.join(root, "scratch"));
  mkdirSync(path.join(root, "work"), { recursive: true });
  const binding = browserBinding(
    root,
    path.join(root, "work"),
    { mode: "background" },
    undefined,
    true,
  );
  const clicks: boolean[] = [];
  const answer: Answer = async (approve) => {
    clicks.push(approve);
    return true;
  };
  const hold = (url = "https://shop.example.test/checkout") =>
    held?.(url, { text: "Place order", total: "$42.10" }, answer);
  return { host, binding, clicks, hold };
}

const pending = (f: Awaited<ReturnType<typeof runtimeFixture>>) =>
  (f.store
    .snapshot(["interaction"])
    .interaction?.filter(
      (row) => String(row.id).startsWith(TAKEOVER_PREFIX) && row.state === "pending",
    ) ?? []) as { id: string; type: string; title?: string; items?: { prompt?: string }[] }[];

function answer(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  id: string,
  action: "accept" | "decline",
) {
  const before = f.store.lastSeq();
  f.store.dispatch(`answer:${id}`, (state) =>
    handle(
      state,
      {
        type: "answer",
        id,
        version: 1,
        answer: {
          action,
          ...(action === "accept" ? { choice: "allow_once" } : {}),
          by: { kind: "human", id: "local-owner" },
          at,
        },
      },
      { commandId: `answer:${id}`, at, actor: { kind: "human", id: "local-owner" } },
    ),
  );
  return f.store.eventsSince(before);
}

it("holds a pay click on a card; Place order clicks it once, Cancel tells the agent", async () => {
  const f = await runtimeFixture();
  try {
    const { host, binding, clicks, hold } = setup(f.root);
    const takeover = takeoverApi({ store: f.store, host: () => host, ready: (s) => s(host) });
    await host.ensure(binding, "thread");

    hold();
    const [card] = pending(f);
    expect(card).toMatchObject({
      type: "approval",
      title: "Confirm purchase on shop.example.test",
      items: [
        {
          prompt:
            "Fixture wants to click “Place order” on this page. This may complete a payment.\nTotal shown on the page: $42.10",
          options: [
            { id: "cancel", label: "Cancel" },
            { id: "allow-click", label: "Allow click" },
          ],
        },
      ],
    });
    expect(clicks).toEqual([]);
    // The agent's browser commands wait, and the panel doesn't say the owner is in control.
    expect(existsSync(controlFile(binding))).toBe(true);
    expect(host.view("v", "thread", false, () => {})).toMatchObject({ control: false });
    // A second pay click while one waits is dropped.
    hold();
    expect(clicks).toEqual([false]);
    expect(pending(f)).toHaveLength(1);

    takeover.observe(answer(f, String(card?.id), "accept"));
    await expect.poll(() => clicks).toEqual([false, true]);
    expect(existsSync(controlFile(binding))).toBe(false);
    expect(readFileSync(notesFile(binding), "utf8")).toContain(
      "The owner confirmed the purchase, and the button was clicked once.",
    );

    hold();
    takeover.observe(answer(f, String(pending(f)[0]?.id), "decline"));
    await expect.poll(() => clicks).toEqual([false, true, false]);
    expect(readFileSync(notesFile(binding), "utf8")).toContain("The owner declined the purchase.");
    expect(existsSync(controlFile(binding))).toBe(false);
  } finally {
    f.close();
  }
});

it("lets the owner's own clicks and listed sites through, and Take over drops a held click", async () => {
  const f = await runtimeFixture();
  try {
    const { host, binding, clicks, hold } = setup(f.root);
    const takeover = takeoverApi({ store: f.store, host: () => host, ready: (s) => s(host) });
    await host.ensure(binding, "thread");
    host.purchaseSites = () => ["groceries.example.test"];
    hold("https://www.groceries.example.test/pay");
    expect(clicks).toEqual([true]);
    expect(pending(f)).toEqual([]);

    takeover.take("thread");
    hold();
    expect(clicks).toEqual([true, true]);
    takeover.handBack("thread");

    hold();
    expect(pending(f)).toHaveLength(1);
    takeover.take("thread");
    await expect.poll(() => clicks).toEqual([true, true, false]);
    expect(pending(f)).toMatchObject([{ title: "You’re in control of the browser" }]);
    expect(readFileSync(notesFile(binding), "utf8")).toContain(
      "The owner took over the browser instead of confirming the purchase, so nothing was clicked.",
    );
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

describe.skipIf(!shell)("purchase guard in a real browser", () => {
  it("holds pay buttons in their many forms, and approval clicks exactly once", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-purchase-"));
    const held: { details: PurchaseDetails; answer: Answer }[] = [];
    const browser = await playwrightEngine(root, { executablePath: shell as string }).launch({
      userDataDir: path.join(root, "data"),
      headless: true,
      title: `zb-purchase-${Date.now()}`,
      purchase: (_url, details, answer) => held.push({ details, answer }),
    });
    const page = browser.pages()[0] as EnginePage;
    let stop = () => {};
    const count = () => page.evaluate<number>("window.done || 0");
    const press = async (selector: string) => {
      const box = await page.evaluate<{ x: number; y: number }>(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      await page.mouse({ type: "move", x: box.x, y: box.y });
      await page.mouse({ type: "down", x: box.x, y: box.y, button: "left" });
      await page.mouse({ type: "up", x: box.x, y: box.y, button: "left" });
    };
    const show = async (html: string) => {
      await page.evaluate(
        `(() => { window.done = 0; document.body.innerHTML = ${JSON.stringify(html)}; })()`,
      );
    };
    const did = 'onclick="window.done = (window.done || 0) + 1"';
    try {
      // A fresh document from a local server, so the guard runs in it from the start.
      const server = createServer((_, res) => {
        res.setHeader("content-type", "text/html");
        res.end("<!doctype html><title>shop</title><body></body>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      stop = () => server.close();
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      await page.evaluate(`location.href = ${JSON.stringify(url)}`).catch(() => {});
      await expect.poll(() => page.url()).toBe(url);
      await expect.poll(() => page.evaluate<string>("document.title").catch(() => "")).toBe("shop");
      // Plain and priced buttons, an icon-only button, a translated submit, a link.
      const cases: [string, string, string][] = [
        [
          `<p>Order total: $42.10</p><button id=t ${did}>Place order</button>`,
          "Place order",
          "$42.10",
        ],
        [`<button id=t ${did}><span>Pay $19.99</span></button>`, "Pay $19.99", ""],
        [
          `<button id=t aria-label="Buy now" ${did}><svg width=20 height=20></svg></button>`,
          "Buy now",
          "",
        ],
        [
          `<div>Gesamtsumme: 12,50 €</div><input id=t type=button value="Jetzt kaufen" ${did}>`,
          "Jetzt kaufen",
          "12,50 €",
        ],
        [`<a id=t href="#" ${did}>Pay now</a>`, "Pay now", ""],
        [
          `<div id=t onclick="window.done = (window.done || 0) + 1">Confirm &amp; pay · $8</div>`,
          "Confirm & pay · $8",
          "",
        ],
        [
          `<button id=t ${did}>Place order (opens new window)</button>`,
          "Place order (opens new window)",
          "",
        ],
      ];
      for (const [html, text, total] of cases) {
        held.length = 0;
        await show(html);
        await press("#t");
        await expect.poll(() => held.length, { message: text }).toBe(1);
        expect(held[0]?.details).toEqual({ text, total });
        expect(await count()).toBe(0);
        // The agent can't click it with a script either while it's held, or after.
        await page.evaluate("document.querySelector('#t').click()");
        expect(await count()).toBe(0);
        expect(await held[0]?.answer(true)).toBe(true);
        expect(await count()).toBe(1);
        // Approval clicks exactly once.
        expect(await held[0]?.answer(true)).toBe(false);
        expect(await count()).toBe(1);
      }

      // A form that posts to a payment step, submitted by a neutral button.
      held.length = 0;
      await show(
        `<form action="/checkout/complete" onsubmit="event.preventDefault(); window.done = (window.done || 0) + 1"><button id=t>Continue</button></form>`,
      );
      await press("#t");
      await expect.poll(() => held.length).toBe(1);
      expect(await count()).toBe(0);
      expect(await held[0]?.answer(false)).toBe(true);
      expect(await count()).toBe(0);

      // A submit with no name, posting to payment, still raises a card, and the frame isn't stuck.
      held.length = 0;
      await show(
        `<form action="/payment" onsubmit="event.preventDefault(); window.done = (window.done || 0) + 1"><input id=t type=submit value=""></form>`,
      );
      await press("#t");
      await expect.poll(() => held.length).toBe(1);
      expect(held[0]?.details.text).toBe("a pay button");
      expect(await held[0]?.answer(true)).toBe(true);
      expect(await count()).toBe(1);

      // Everything else clicks normally.
      held.length = 0;
      await show(`<button id=t ${did}>Add to cart</button><a href="#" ${did}>Payment methods</a>`);
      await press("#t");
      expect(await count()).toBe(1);
      expect(held).toEqual([]);
    } finally {
      stop();
      await browser.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
