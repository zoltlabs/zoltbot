import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("Fast mode switches the agent to the provider's faster tier", async ({ page }) => {
  const fixture = await compareFixture({ serviceTiers: ["fast"] });
  const shell = await shellSession(fixture.daemon);
  try {
    const bot = await shell.service.createBot({ profileId: "profile", title: "Quick fixes" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Quick fixes/ })
      .click();
    // The session starts with the first message; its capabilities list the tier.
    const composer = page.getByRole("textbox", { name: "Message Quick fixes" });
    await composer.click();
    await composer.pressSequentially("Hello");
    await composer.press("Enter");
    await expect(page.getByText("First answer")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /^Agent model/ }).click();
    const panel = page.getByRole("dialog", { name: "Choose agent model" });
    const speed = panel.getByRole("button", { name: /^Speed/ });
    await expect(speed).toHaveAccessibleName("Speed: Standard");
    await expect(panel.getByText("Uses more of your plan")).toBeHidden();

    await speed.click();
    await page.getByRole("option", { name: "Fast" }).click();
    await expect(speed).toHaveAccessibleName("Speed: Fast");
    await expect(panel.getByText("Uses more of your plan")).toBeVisible();
    await expect.poll(() => fixture.natives.get(bot.threadId ?? "")?.tiers).toEqual(["fast"]);
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      // settleColorScheme alone left this page in its first scheme; set it directly too.
      await page.emulateMedia({ colorScheme: scheme });
      if (process.env.ZB_SHOTS)
        await page.screenshot({ path: `${process.env.ZB_SHOTS}/a5-fast-mode-on-${scheme}.png` });
    }

    await speed.click();
    await page.getByRole("option", { name: "Standard" }).click();
    await expect(speed).toHaveAccessibleName("Speed: Standard");
    await expect.poll(() => fixture.natives.get(bot.threadId ?? "")?.tiers).toEqual(["fast", null]);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
