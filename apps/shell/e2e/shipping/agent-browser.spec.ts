import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type {
  BrowserEngine,
  EngineFrame,
  EnginePage,
} from "../../../../packages/daemon/src/browser/engine";
import { browserHostFor, forgetBrowserHost } from "../../../../packages/daemon/src/browser/host";
import { browserBinding } from "../../../../packages/daemon/src/browser/runtime";
import { helpFile, notesFile } from "../../../../packages/daemon/src/browser/takeover-files";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** A page that sends frames on a timer while someone watches. */
class FramePage implements EnginePage {
  watching = 0;
  readonly input: unknown[] = [];
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
  async mouse(event: unknown) {
    this.input.push(event);
  }
  async key(event: unknown) {
    this.input.push(event);
  }
  async evaluate<T>() {
    return undefined as T;
  }
  onClose() {}
  onLoad() {}
}

test("the Browser panel shows the agent’s browser live, lets the owner take over, and stops streaming when closed", async ({
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
    const binding = browserBinding(dataDir, work, { mode: "background" }, undefined, true);
    await host?.ensure(binding, String(bot.threadId));
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

    // B3: Take over. The agent waits on a card; the owner's clicks and keys reach the page.
    await panel.getByRole("button", { name: "Take over" }).click();
    await expect(panel.locator(".agent-browser-control-status")).toHaveText("You’re in control");
    const control = panel.getByRole("application", { name: "Research’s browser" });
    await expect(control).toBeFocused();
    const box = await control.boundingBox();
    if (!box) throw Error("no canvas");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type("hi");
    await expect
      .poll(() => framePage.input.filter((e) => (e as { type?: string }).type !== "move").length)
      .toBe(6);
    expect(framePage.input.filter((e) => (e as { type?: string }).type !== "move")).toEqual([
      expect.objectContaining({ type: "down", button: "left" }),
      expect.objectContaining({ type: "up", button: "left" }),
      { type: "down", key: "h" },
      { type: "up", key: "h" },
      { type: "down", key: "i" },
      { type: "up", key: "i" },
    ]);
    const card = () =>
      fixture.daemon.store
        .snapshot(["interaction"])
        .interaction?.find((row) => String(row.id).startsWith("browser-takeover:"));
    expect(card()).toMatchObject({ type: "gate", state: "pending" });
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/b3-control-${scheme}.png` });
    }
    // Typed text never reaches the daemon's log.
    expect(readFileSync(path.join(dataDir, "daemon.log"), "utf8")).not.toContain("browser.input");

    // Esc twice leaves the page for the panel's Hand back; the first Esc reaches the page.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("button", { name: "Hand back" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name: "Take over" })).toBeFocused();
    await expect(panel.getByText("Research has the browser again.")).toBeAttached();
    expect(card()).toMatchObject({ state: "answered" });
    expect(readFileSync(notesFile(binding), "utf8")).toContain(
      "The owner used the browser and handed it back at https://shop.example.test/orders.",
    );
    expect(existsSync(path.join(binding.home, "control.json"))).toBe(false);

    // Handing back from the chat's card works too; the panel catches up on its next renewal.
    await panel.getByRole("button", { name: "Take over" }).click();
    const prompt = page.getByRole("region", { name: "You’re in control of the browser" });
    await expect(prompt.getByText("Research waits until you hand it back.")).toBeVisible();
    await prompt.getByRole("button", { name: "Hand back" }).click();
    await expect(panel.getByRole("button", { name: "Take over" })).toBeVisible({ timeout: 10_000 });
    expect(existsSync(path.join(binding.home, "control.json"))).toBe(false);

    // B4: the agent asks for a sign-in. The chat's card names the site; Take over opens the panel.
    await panel.getByRole("button", { name: "Close browser" }).click();
    writeFileSync(
      helpFile(binding),
      JSON.stringify({ reason: "sign_in", note: "Sign in to see past orders." }),
    );
    const ask = page.getByRole("region", {
      name: "Research needs you to sign in to shop.example.test",
    });
    await expect(ask.getByText("Sign in to see past orders.")).toBeVisible({ timeout: 10_000 });
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/b4-ask-${scheme}.png` });
    }
    await ask.getByRole("button", { name: "Take over" }).click();
    await expect(panel.locator(".agent-browser-control-status")).toHaveText("You’re in control", {
      timeout: 10_000,
    });
    await panel.getByRole("button", { name: "Hand back" }).click();
    await expect(panel.getByRole("button", { name: "Take over" })).toBeVisible();
    expect(existsSync(path.join(binding.home, "control.json"))).toBe(false);

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
