import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** Screenshots of each screen in each theme, for review. The folder is ignored by git. */
const SCREENSHOTS = fileURLToPath(new URL("../../../../output/themes/", import.meta.url));

/** Runs axe in both color schemes and saves a screenshot of the screen in each. */
async function checkScreen(page: Page, name: string) {
  expect.soft(await axeViolations(page), name).toEqual([]);
  for (const scheme of COLOR_SCHEMES) {
    await settleColorScheme(page, scheme);
    await page.screenshot({ path: join(SCREENSHOTS, `${name}-${scheme}.png`) });
  }
  await settleColorScheme(page, "dark");
}

test("main screens pass axe in the dark and light themes", async ({ page }) => {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createProject(mkdtempSync(join(tmpdir(), "example-project-")));
    await shell.service.createBot({ profileId: "profile", title: "Research" });
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });

    // Conversation with a reply and an open question.
    await sidebar.getByRole("button", { name: /^Release notes(?: |$)/ }).click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await expect(composer).toBeVisible();
    await checkScreen(page, "chat-empty");
    await composer.click();
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");
    await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });
    await composer.pressSequentially("Ask me a question");
    await composer.press("Enter");
    await expect(page.getByText("Choose an approach").last()).toBeVisible({ timeout: 15_000 });
    await checkScreen(page, "chat-question");
    await page
      .getByRole("button", { name: /Use this approach/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Send answer" }).click();
    await expect(page.getByText("Choose an approach")).toHaveCount(0, { timeout: 15_000 });

    // Model picker.
    await page.getByRole("button", { name: /^Agent model:/ }).click();
    await checkScreen(page, "model-picker");
    await page.keyboard.press("Escape");

    // Agent settings.
    await page.getByRole("button", { name: "View agent settings" }).click();
    await expect(page.getByRole("complementary", { name: "Agent settings" })).toBeVisible();
    await checkScreen(page, "agent-settings");
    await page.getByRole("button", { name: "View agent settings" }).click();

    // Agent context menu and delete confirmation.
    await sidebar.getByRole("button", { name: /^Research(?: |$)/ }).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Agent actions" });
    await expect(menu).toBeVisible();
    await checkScreen(page, "context-menu");
    await menu.getByRole("menuitem", { name: "Delete agent" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete Research?" });
    await expect(confirm).toBeVisible();
    await checkScreen(page, "delete-dialog");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toHaveCount(0);

    // Account menu.
    await page.getByRole("button", { name: "Account menu" }).click();
    await checkScreen(page, "account-menu");
    await page.keyboard.press("Escape");

    // Project chat and its organization.
    await sidebar.getByRole("button", { name: /CEO/ }).first().click();
    await page.getByRole("button", { name: "Organization", exact: true }).first().click();
    await expect(page.getByRole("complementary", { name: "Organization" })).toBeVisible();
    await checkScreen(page, "organization");

    // Map.
    await sidebar.getByRole("button", { name: "Map", exact: true }).click();
    await expect(page.getByText("The command map isn't installed.")).toBeVisible();
    await checkScreen(page, "map");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
