import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, showWorkspaceTree } from "./desktop.js";

test("creates nested teams, starts chats from the composer and keeps the rest one line each", async () => {
  let fixture = await launch("chat");
  let { page } = fixture;
  try {
    const tree = page.getByLabel("Workspace tree", { exact: true });
    const side = page.getByRole("region", { name: /starts with$/ });
    // The rest of the workspace sits behind Details so the page opens on the composer.
    const details = async () => {
      const button = page.getByRole("button", { name: "Details", exact: true });
      if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
    };
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Zolt");
    await expect(page.getByLabel("Goal", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Zolt", exact: true, level: 1 })).toBeVisible();
    await expect(side).toHaveCount(0);
    await details();
    await expect(side.getByRole("region", { name: "Instructions" })).toContainText(
      "No code folder",
    );
    await expect(page.getByRole("button", { name: "Find and fix a failing test" })).toBeVisible();
    const team = async (name: string) => {
      await details();
      await side
        .getByRole("region", { name: "Teams", exact: true })
        .getByRole("button", { name: "Add", exact: true })
        .click();
      await page.getByLabel("Team name", { exact: true }).fill(name);
      await page.getByRole("button", { name: "Create team", exact: true }).click();
      await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
    };
    await team("Zolt Product");
    await team("Food logging");
    const lead = side.getByRole("region", { name: "Lead chat", exact: true });
    await details();
    await expect(lead).toContainText("Off.");
    await lead.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(
      page
        .getByRole("form", { name: "Assign manager", exact: true })
        .getByLabel("Profile", { exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Save manager", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Manager", exact: true })).toBeVisible();
    await tree.getByRole("button", { name: "Food logging", exact: true }).click();
    for (const title of ["Nutrient totals", "Meal search"]) {
      await page.getByLabel("Start a chat in this team", { exact: true }).fill(title);
      await page.getByRole("button", { name: "Start chat", exact: true }).click();
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await tree.getByRole("button", { name: "Food logging", exact: true }).click();
    }
    const chats = page.getByRole("region", { name: /^Chats/ });
    await expect(chats).toContainText("Nutrient totals");
    await expect(chats).toContainText("Meal search");
    await details();
    await expect(lead).toContainText("On ·");
    await tree.getByRole("button", { name: "Zolt Product", exact: true }).click();
    await details();
    await expect(side.getByRole("region", { name: "Teams", exact: true })).toContainText(
      "Food logging",
    );
    await expect(chats).toContainText("Meal search");
    await expect(lead.getByRole("button", { name: "Turn on", exact: true })).toBeVisible();
    await fixture.app.close();
    fixture = await launch("chat", fixture.dataDir);
    page = fixture.page;
    await showWorkspaceTree(page);
    const reopened = page.getByLabel("Workspace tree", { exact: true });
    await reopened.getByRole("button", { name: "Food logging", exact: true }).click();
    await details();
    await expect(
      page
        .getByRole("region", { name: "Lead chat", exact: true })
        .getByRole("button", { name: "Open", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: /^Chats/ })).toContainText("Meal search");
    await page.screenshot({ path: "output/playwright/workspaces-light.png", fullPage: true });
    const workspaceTree = () => page.getByLabel("Workspace tree", { exact: true });
    // The page scrolls inside the shell, so a tall window shows the whole page at once.
    const shoot = async (theme: "Light" | "Dark") => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("radio", { name: theme, exact: true }).check();
      await showWorkspaceTree(page);
      await workspaceTree().getByRole("button", { name: "Zolt Product", exact: true }).click();
      await page.setViewportSize({ width: 1320, height: 1500 });
      await page.screenshot({
        path: `output/playwright/workspace-home-${theme.toLowerCase()}.png`,
      });
      await page.setViewportSize({ width: 1320, height: 873 });
      await workspaceTree().getByRole("button", { name: "Food logging", exact: true }).click();
    };
    await shoot("Light");
    await shoot("Dark");
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await showWorkspaceTree(page);
    await workspaceTree().getByRole("button", { name: "Food logging", exact: true }).click();
    await page.screenshot({ path: "output/playwright/workspaces-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 760, height: 850 });
    await page.screenshot({ path: "output/playwright/workspaces-narrow.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});
