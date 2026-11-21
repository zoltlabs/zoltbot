import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("Add free models appends the catalog's free models to the backup order", async ({ page }) => {
  const fixture = await compareFixture({
    models: [
      { id: "big", name: "Big" },
      { id: "mini:free", name: "Mini" },
    ],
  });
  const shell = await shellSession(fixture.daemon);
  try {
    // A chat runs once, so the catalog knows the tool's models.
    const bot = await shell.service.createBot({ profileId: "profile", title: "Triage" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Triage/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Triage" });
    await composer.click();
    await composer.pressSequentially("Hello");
    await composer.press("Enter");
    await expect(page.getByText("First answer")).toBeVisible({ timeout: 15_000 });
    expect(bot.id).toBeTruthy();

    await page.getByRole("button", { name: "Models", exact: true }).click();
    const models = page.getByRole("main", { name: "Models" });
    const add = models.getByRole("button", { name: "Add free models" });
    await expect(add).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      if (process.env.ZB_SHOTS)
        await page.screenshot({ path: `${process.env.ZB_SHOTS}/a7-free-backups-${scheme}.png` });
    }
    await add.click();
    // Tools sharing an adapter list the same model; it is added once.
    await expect(models.getByText("Mini (free)")).toBeVisible();
    await expect(add).toBeHidden();
    const read = await shell.service.accounts.read();
    expect(read.orders.employee).toEqual([{ accountId: "default:fake", model: "mini:free" }]);
    // The tool's paid default model can still be added next to its free one.
    await models.getByRole("button", { name: /^Account to add:/ }).click();
    await expect(page.getByRole("option", { name: "Fake" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
