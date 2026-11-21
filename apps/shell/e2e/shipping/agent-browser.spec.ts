import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type {
  BrowserEngine,
  EngineFrame,
  EnginePage,
} from "../../../../packages/daemon/src/browser/engine";
import { browserHostFor, forgetBrowserHost } from "../../../../packages/daemon/src/browser/host";
import { browserBinding } from "../../../../packages/daemon/src/browser/runtime";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** A page that sends frames on a timer while someone watches. */
class FramePage implements EnginePage {
  watching = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly jpeg: Buffer,
    readonly address: string,
  ) {}
  url() {
    return this.address;
  }
  async frames(onFrame: (frame: EngineFrame) => void) {
    this.watching++;
    this.timer = setInterval(() => onFrame({ data: this.jpeg, width: 1024, height: 720 }), 150);
    return async () => {
      this.watching--;
      clearInterval(this.timer);
    };
  }
  async mouse() {}
  async key() {}
  async evaluate<T>() {
    return undefined as T;
  }
  onClose() {}
  onLoad() {}
}

test("the Browser panel shows the agent's browser live and stops streaming when closed", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const bot = await shell.service.createBot({ profileId: "profile", title: "Research" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Research/ })
      .click();

    // Before the agent opens a page.
    await page.getByRole("button", { name: "Open browser" }).click();
    const panel = page.getByRole("complementary", { name: "Browser" });
    await expect(panel.getByText("Research hasn’t opened a page yet.")).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/b2-empty-${scheme}.png` });
    }

    // The agent's browser opens a page; a picture of a real page stands in for its frames.
    const source = await page.context().newPage();
    await source.setViewportSize({ width: 1024, height: 720 });
    await source.setContent(
      "<body style='font:32px system-ui;padding:48px'><h1>Order history</h1><p>3 orders</p><button style='font:24px system-ui'>Sign in</button></body>",
    );
    const jpeg = await source.screenshot({ type: "jpeg", quality: 60 });
    await source.close();
    const framePage = new FramePage(jpeg, "https://shop.example.test/orders");
    let pointer: ((page: EnginePage, point: { x: number; y: number }) => void) | undefined;
    const engine: BrowserEngine = {
      async launch() {
        return {
          endpoint: "/tmp/fake.sock",
          pages: () => [framePage],
          onPage() {},
          onPointer: (listener) => {
            pointer = listener;
          },
          async close() {},
        };
      },
    };
    const { dataDir } = fixture.daemon;
    const host = browserHostFor(dataDir, () => engine);
    const work = path.join(dataDir, "work");
    mkdirSync(work, { recursive: true });
    await host?.ensure(
      browserBinding(dataDir, work, { mode: "background" }, undefined, true),
      String(bot.threadId),
    );
    pointer?.(framePage, { x: 96, y: 150 });

    const screen = panel.getByRole("img", { name: "Research’s browser" });
    await expect(screen).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText("https://shop.example.test/orders")).toBeVisible();
    expect(host?.streaming(String(bot.threadId))).toBe(true);
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/b2-live-${scheme}.png` });
    }

    // Closing the panel stops the screencast.
    await panel.getByRole("button", { name: "Close browser" }).click();
    await expect(panel).toBeHidden();
    await expect.poll(() => framePage.watching).toBe(0);
    expect(shell.errors).toEqual([]);
  } finally {
    await forgetBrowserHost(fixture.daemon.dataDir);
    await shell.close();
    await fixture.close();
  }
});
