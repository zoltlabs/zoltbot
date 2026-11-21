import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, settleColorScheme, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Nothing on the page is wider than the window. */
const overflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

test("Appearance changes the theme, text size, font and chat background", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);

    // The harness's color schemes really switch the shell: both token sets follow.
    await settleColorScheme(page, "light");
    expect(await theme(page)).toBe("light");
    const light = await background(page);
    await settleColorScheme(page, "dark");
    expect(await theme(page)).toBe("dark");
    expect(await background(page)).not.toBe(light);

    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");
    await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Appearance" }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    await expect(dialog).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d1-dialog.png` });

    const choose = async (label: string, option: string) => {
      await dialog.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };

    // An explicit theme wins over the system's.
    await choose("Theme", "Light");
    expect(await theme(page)).toBe("light");
    await choose("Theme", "System");
    expect(await theme(page)).toBe("dark");

    // Every chat background keeps the transcript readable in both themes.
    await dialog.getByRole("button", { name: "Done" }).click();
    for (const fill of ["Tint", "Dots", "Grid", "None"]) {
      await page.getByRole("button", { name: "Open account menu" }).click();
      await page.getByRole("menu").getByRole("menuitem", { name: "Appearance" }).click();
      await choose("Chat background", fill);
      await dialog.getByRole("button", { name: "Done" }).click();
      expect(await axeViolations(page), fill).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/d1-${fill.toLowerCase()}.png` });
    }

    // The largest text and another font. Text size is the window's zoom, set by main; at 1.25 a
    // 1280-wide window lays out like a 1024-wide page, so check that width for overflow.
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Appearance" }).click();
    await choose("Text size", "Larger");
    await choose("Font", "Serif");
    expect(
      await page.evaluate(async () => {
        const saved = await (
          window as unknown as {
            openbot: { preferences: { get(): Promise<{ textSize: string; font: string }> } };
          }
        ).openbot.preferences.get();
        return { textSize: saved.textSize, font: document.documentElement.dataset.font };
      }),
    ).toEqual({ textSize: "larger", font: "serif" });
    const size = page.viewportSize() ?? { width: 1280, height: 820 };
    await page.setViewportSize({
      width: Math.round(size.width / 1.25),
      height: Math.round(size.height / 1.25),
    });
    expect(await overflows(page)).toBe(false);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d1-larger-settings.png` });
    await dialog.getByRole("button", { name: "Done" }).click();
    expect(await overflows(page)).toBe(false);
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d1-larger-chat.png` });
    await page.setViewportSize(size);

    // Saved: a reload keeps every choice.
    await page.reload();
    await expect(page.getByRole("complementary", { name: "Bot navigation" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.font))
      .toBe("serif");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
