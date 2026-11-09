import { writeFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, navigateMain, showWorkspaceTree } from "./desktop.js";

test("makes a routine from a finished task and shows its next run and linked history", async () => {
  const fixture = await launch("chat");
  const { page, dataDir } = fixture;
  try {
    writeFileSync(path.join(dataDir, "routine-clock.txt"), "2026-11-04T00:00:00.000Z");
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Routine project");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await navigateMain(page, "Tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Daily check");
    await page.getByLabel("Goal", { exact: true }).fill("Check status.");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    const card = page.getByRole("article", { name: "Daily check", exact: true });
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    await card.getByRole("button", { name: "Make this a routine", exact: true }).click();
    await page.getByLabel("Schedule", { exact: true }).fill("@every 60m");
    await page.getByLabel("Timezone", { exact: true }).fill("America/New_York");
    await page.getByRole("button", { name: "Save routine", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
    await expect(page.getByText(/Next run:/)).toContainText("America/New_York");
    await expect(page.getByRole("heading", { name: "Run history", exact: true })).toBeVisible();
    await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
    writeFileSync(path.join(dataDir, "routine-clock.txt"), "2026-11-04T01:00:00.000Z");
    await expect(
      page.getByRole("listitem").filter({ hasText: "completed · actionable" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Open task", exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/routines-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Open task", exact: true }).click();
    await expect(page.getByText("Check status.", { exact: false })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});
