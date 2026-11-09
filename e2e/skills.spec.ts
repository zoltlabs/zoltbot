import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { launch } from "./desktop.js";

/** The theme radios live on Settings › General, so other tabs switch theme from the header. */
async function applyTheme(page: Page, theme: string) {
  const value = theme.toLowerCase();
  if ((await page.locator("html").getAttribute("data-theme")) !== value)
    await page.getByRole("button", { name: `Use ${value} theme`, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", value);
}

test("reviews a skill copy, retains edits and removes safely in both themes", async () => {
  const fixture = await launch(true),
    { page } = fixture;
  mkdirSync(".cache/e2e", { recursive: true });
  const source = realpathSync(mkdtempSync(path.resolve(".cache/e2e/skill-source-")));
  writeFileSync(
    path.join(source, "SKILL.md"),
    "---\nname: release-notes\ndescription: Write concise release notes\n---\nSummarize approved changes.\n",
  );
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Coding agents", exact: true }).click();
    const skills = page.getByRole("region", { name: "Skills", exact: true });
    await skills.getByLabel("Local skill folder", { exact: true }).fill(source);
    await skills.getByRole("button", { name: "Review import", exact: true }).click();
    await expect(skills.getByRole("region", { name: "Import preview" })).toContainText("SKILL.md");
    await skills.getByRole("button", { name: "Add to library", exact: true }).click();
    await expect(
      skills.getByRole("heading", { name: "release-notes · v1", exact: true }),
    ).toBeVisible();
    await skills.getByRole("button", { name: "Edit", exact: true }).click();
    await skills
      .getByLabel("Instructions (Markdown)", { exact: true })
      .fill("New instructions for future sessions.");
    await skills.getByRole("button", { name: "Save version", exact: true }).click();
    await expect(
      skills.getByRole("heading", { name: "release-notes · v2", exact: true }),
    ).toBeVisible();
    await skills.getByText("Profile access", { exact: true }).click();
    await skills.getByLabel("Profile", { exact: true }).selectOption("p");
    await skills.getByLabel("Scope", { exact: true }).selectOption("project");
    await skills.getByRole("button", { name: "Enable v2…", exact: true }).click();
    const access = page.getByRole("dialog", { name: "Enable skill for this profile?" });
    await expect(access).toBeVisible();
    await access.getByRole("button", { name: "Enable skill", exact: true }).click();
    await expect(skills.getByText("Enabled v2", { exact: true })).toBeVisible();
    await skills.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(skills.getByText("Disabled", { exact: true })).toBeVisible();
    await skills.getByText("Versions", { exact: true }).click();
    await expect(skills.getByText(/^v1 ·/)).toBeVisible();
    for (const theme of ["Light", "Dark"]) {
      await applyTheme(page, theme);
      expect(
        (await new AxeBuilder({ page }).include(".skills-settings").setLegacyMode().analyze())
          .violations,
      ).toEqual([]);
      await skills.screenshot({ path: `output/playwright/skills-${theme.toLowerCase()}.png` });
    }
    await skills.getByRole("button", { name: "Remove", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Remove skill from the library?" });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).not.toBeVisible();
    await expect(skills.getByRole("button", { name: "Remove", exact: true })).toBeFocused();
    await skills.getByRole("button", { name: "Remove", exact: true }).click();
    await confirm.getByRole("button", { name: "Remove from library", exact: true }).click();
    await expect(
      skills.getByText("No skills yet. Create one or review a local folder.", { exact: true }),
    ).toBeVisible();
    await skills
      .getByLabel("Local skill folder", { exact: true })
      .fill(path.join(source, "missing"));
    await skills.getByRole("button", { name: "Review import", exact: true }).click();
    await expect(skills.getByRole("alert")).toBeVisible();
    for (const theme of ["Light", "Dark"]) {
      await applyTheme(page, theme);
      expect(
        (await new AxeBuilder({ page }).include(".skills-settings").setLegacyMode().analyze())
          .violations,
      ).toEqual([]);
    }
  } finally {
    await fixture.cleanup();
    rmSync(source, { recursive: true, force: true });
  }
});
