import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Release notes" });
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

test("the context meter offers Compact when the chat is almost full", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();

    // The fake fills 85% of its window when asked about a long context.
    await send(page, "Read this long context");
    const meter = page.getByRole("meter", { name: "Context 85% full" });
    await expect(meter).toBeVisible({ timeout: 15_000 });
    await meter.focus();
    await expect(page.getByRole("tooltip")).toHaveText("85,000 of 100,000 tokens");
    const bar = page.getByRole("region", { name: "Context almost full" });
    await expect(bar).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await bar.getByRole("button", { name: "Compact" }).click();
    await expect(page.getByRole("meter", { name: "Context 12% full" })).toBeVisible();
    await expect(bar).toBeHidden();
    await expect(page.locator(".model-notice").filter({ hasText: "Compacted" })).toBeVisible();

    // Set to compact on its own, the chat compacts after a turn that ends nearly full.
    await page.getByRole("button", { name: "View agent settings" }).click();
    await page.getByRole("button", { name: /^When context is full/ }).click();
    await page.getByRole("option", { name: "Compact automatically" }).click();
    await send(page, "Another very long context");
    await expect(page.locator(".model-notice").filter({ hasText: "Compacted" })).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(page.getByRole("meter", { name: "Context 12% full" })).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
