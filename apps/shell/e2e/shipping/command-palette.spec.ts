import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("the command palette opens with Command-K, finds a chat and a page, and runs them", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.service.createBot({ profileId: "profile", title: "Bug triage" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Bug triage/ }).click();
    const composer = page.getByRole("textbox", { name: "Message Bug triage" });
    await composer.click();

    await page.keyboard.press("ControlOrMeta+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const search = palette.getByRole("combobox", { name: "Search or run a command" });
    await expect(search).toBeFocused();
    await expect(palette.getByRole("group", { name: "Pages" })).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await search.pressSequentially("release");
    await expect(palette.getByRole("option").first()).toHaveText(/Release notes/);
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message Release notes" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+K");
    await search.pressSequentially("models");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Models" }).first()).toBeVisible();

    // Escape closes it.
    await page.keyboard.press("ControlOrMeta+K");
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
