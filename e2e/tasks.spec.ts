import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, navigateMain, showWorkspaceTree } from "./desktop.js";

test("creates a task, reviews it, sends it back as revision 2, accepts it and stops another", async () => {
  let fixture = await launch("chat");
  let { page } = fixture;
  try {
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Zolt");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Zolt", exact: true, level: 1 })).toBeVisible();

    await navigateMain(page, "Tasks");
    await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Show units");
    await page.getByLabel("Goal", { exact: true }).fill("Show grams and ounces on meals.");
    await page.getByLabel("Done when (optional)", { exact: true }).fill("Both units render.");
    await expect(page.getByLabel("Workspace or team", { exact: true })).toHaveValue(/^project:/);
    await page.getByRole("button", { name: "Create task", exact: true }).click();

    const needsYou = page.getByRole("region", { name: "Needs you", exact: true });
    const card = needsYou.getByRole("article", { name: "Show units" });
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(card.getByRole("region", { name: /^Result for Show units,/ })).toHaveText("ok");
    await expect(page.getByRole("button", { name: /^Tasks/ })).toContainText("1");

    await card.getByRole("button", { name: "Request changes", exact: true }).click();
    await card.getByLabel("What should change?", { exact: true }).fill("Round to one decimal.");
    await card.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(card.getByText(/Revision 2/)).toBeVisible({ timeout: 15000 });
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: "output/playwright/tasks-review-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await card.getByRole("button", { name: "Accept", exact: true }).click();
    const done = page.getByRole("region", { name: "Done", exact: true });
    await expect(done.getByRole("article", { name: "Show units" })).toContainText("Accepted");

    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Meal search");
    await page.getByLabel("Goal", { exact: true }).fill("Find meals by name.");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    const second = needsYou.getByRole("article", { name: "Meal search" });
    await expect(second.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    await second.getByRole("button", { name: "Stop", exact: true }).click();
    await second.getByRole("button", { name: "Stop task", exact: true }).click();
    await expect(done.getByRole("article", { name: "Meal search" })).toContainText("Stopped");

    await done
      .getByRole("article", { name: "Show units" })
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    await expect(page.getByText("Round to one decimal.", { exact: false })).toBeVisible();

    await fixture.app.close();
    fixture = await launch("chat", fixture.dataDir);
    page = fixture.page;
    await navigateMain(page, "Tasks");
    await expect(
      page.getByRole("region", { name: "Done", exact: true }).getByRole("article"),
    ).toHaveCount(2);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await navigateMain(page, "Tasks");
    await page.screenshot({ path: "output/playwright/tasks-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 760, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});
