import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("Talking style saves on the agent and says it applies to new chats", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    await page.getByRole("button", { name: "View agent settings" }).click();

    const style = page.getByRole("button", { name: /^Talking style/ });
    await expect(style).toContainText("Neutral");
    await expect(style).toHaveAccessibleDescription("Applies to new chats");
    await style.click();
    for (const name of ["Neutral", "Warm", "Casual", "Direct"])
      await expect(page.getByRole("option", { name })).toBeVisible();
    await page.getByRole("option", { name: "Direct" }).click();
    await expect(style).toContainText("Direct");
    await expect
      .poll(() => shell.service.client.rows("agent").find((row) => row.id === "profile")?.style)
      .toBe("direct");

    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const folder = process.env.ZOLTBOT_SHOTS;
      if (folder) await page.screenshot({ path: `${folder}/a2-settings-${scheme}.png` });
    }

    // Back to Neutral stores the choice rather than leaving the old one.
    await style.click();
    await page.getByRole("option", { name: "Neutral" }).click();
    await expect
      .poll(() => shell.service.client.rows("agent").find((row) => row.id === "profile")?.style)
      .toBe("neutral");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
