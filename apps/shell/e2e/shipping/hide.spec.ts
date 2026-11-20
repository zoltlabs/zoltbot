import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Release notes" });
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

async function hide(page: Page, text: string) {
  const message = page.locator("article.message-entry", { hasText: text }).first();
  await message.hover();
  await message.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Hide" }).click();
}

test("a hidden message folds to one line, with Undo and Show", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    await send(page, "Hide me later");
    await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0, {
      timeout: 15_000,
    });

    // The first hide explains that the agent still remembers the message.
    await hide(page, "Hide me later");
    const dialog = page.getByRole("alertdialog", { name: "Hide this message?" });
    await expect(dialog).toContainText("The agent still remembers it.");
    await dialog.getByRole("button", { name: "Hide" }).click();
    await expect(page.getByText("Hidden message")).toBeVisible();
    await expect(page.locator("article.message-entry", { hasText: "Hide me later" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("article.message-entry", { hasText: "Hide me later" })).toHaveCount(
      1,
    );

    // After the first time, hiding asks nothing; Show brings the message back.
    await hide(page, "Hide me later");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByText("Hidden message")).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await page.getByRole("button", { name: "Show hidden message" }).click();
    await expect(page.locator("article.message-entry", { hasText: "Hide me later" })).toHaveCount(
      1,
    );
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
