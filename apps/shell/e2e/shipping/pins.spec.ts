import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Release notes" });
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

async function menu(page: Page, text: string, item: string) {
  const message = page.locator("article.message-entry", { hasText: text }).first();
  await message.hover();
  await message.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("a pinned message shows in the strip, jumps there, and can be unpinned", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    await send(page, "Keep this in view");
    await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0, {
      timeout: 15_000,
    });

    await menu(page, "Keep this in view", "Pin");
    const strip = page.getByRole("navigation", { name: "Pinned messages" });
    const pin = strip.getByRole("button", { name: "Keep this in view" });
    await expect(pin).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await pin.click();
    await expect(
      page.locator("article.message-entry", { hasText: "Keep this in view" }).first(),
    ).toBeFocused();

    await menu(page, "Keep this in view", "Unpin");
    await expect(strip).toHaveCount(0);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
