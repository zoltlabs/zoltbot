import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, settleColorScheme, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

test("Experimental › Sidebar rail moves the page buttons to a rail that stays when the sidebar hides", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const rail = page.getByRole("navigation", { name: "Pages" });

    // Off by default: the page buttons sit at the top of the list.
    await expect(sidebar.getByRole("button", { name: "Map" })).toBeVisible();
    await expect(rail).toHaveCount(0);

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Experimental" }).click();
    const dialog = page.getByRole("dialog", { name: "Experimental" });
    const toggle = dialog.getByRole("switch", { name: "Sidebar rail" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await axeViolations(page)).toEqual([]);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Done" }).click();

    // On: the rail holds the pages and the list keeps only agents.
    await expect(rail).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Map" })).toHaveCount(0);
    await expect(rail.getByRole("button", { name: "Tasks" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) {
      await settleColorScheme(page, "dark");
      await page.screenshot({ path: `${SHOTS}/rail-dark.png` });
      await settleColorScheme(page, "light");
      await page.screenshot({ path: `${SHOTS}/rail-light.png` });
    }

    // A rail button opens its page.
    await rail.getByRole("button", { name: "Tasks" }).click();
    await expect(rail.getByRole("button", { name: "Tasks" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Hiding the sidebar leaves the rail.
    await sidebar.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(sidebar).toBeHidden();
    await expect(rail).toBeVisible();
    await rail.getByRole("button", { name: "Map" }).click();
    await expect(rail.getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/rail-collapsed.png` });
    await page
      .getByRole("main", { name: "Map" })
      .getByRole("button", { name: "Show sidebar" })
      .click();
    await expect(sidebar).toBeVisible();

    // Turning it off brings the list's page buttons back.
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Experimental" }).click();
    await dialog.getByRole("switch", { name: "Sidebar rail" }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(rail).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Map" })).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
