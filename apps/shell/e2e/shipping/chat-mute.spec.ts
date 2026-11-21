import { expect, type Locator, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

async function choose(page: Page, row: Locator, item: string) {
  await row.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Agent actions" })
    .getByRole("menuitem", { name: item })
    .click();
}

test("Mute from a chat's row menu marks the row and Unmute clears it", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const chat = await shell.service.createBot({ profileId: "profile", title: "Alpha chat" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const row = sidebar.getByRole("button", { name: /^Alpha chat(?: |$)/ });
    await expect(row).toBeVisible();
    await expect(row.getByRole("img", { name: "Muted" })).toHaveCount(0);
    const setting = () =>
      fixture.daemon.store.record("settings", `chat.muted.${chat.threadId}`)?.value;

    await choose(page, row, "Mute");
    await expect(row.getByRole("img", { name: "Muted" })).toBeVisible();
    expect(setting()).toBe(true);
    await expect(page.getByText("Muted. Approvals still notify you.")).toBeVisible();
    // The row's name says it's muted, for screen readers.
    await expect(row).toHaveAccessibleName(/Muted/);

    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const folder = process.env.ZOLTBOT_SHOTS;
      if (folder) await page.screenshot({ path: `${folder}/a3-muted-${scheme}.png` });
    }

    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Agent actions" });
    await expect(menu.getByRole("menuitem", { name: "Unmute" })).toBeVisible();
    const folder = process.env.ZOLTBOT_SHOTS;
    if (folder) await page.screenshot({ path: `${folder}/a3-menu.png` });
    await menu.getByRole("menuitem", { name: "Unmute" }).click();
    await expect(row.getByRole("img", { name: "Muted" })).toHaveCount(0);
    expect(setting()).toBe(false);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
