import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { testUiUrl } from "./desktop.js";

for (const theme of ["light", "dark"]) {
  test(`worktree review preview, keyboard and errors in ${theme}`, async ({ page }) => {
    await page.goto(testUiUrl);
    const modulePath = `/@fs/${process.cwd()}/e2e/worktree-gallery.tsx`;
    await page.evaluate(
      async ({ modulePath, theme }) => {
        const gallery = await import(modulePath);
        gallery.mountWorktreeGallery(theme, false);
      },
      { modulePath, theme },
    );
    await page.getByRole("button", { name: "Inspect changes", exact: true }).focus();
    await page.keyboard.press("Enter");
    const review = page.getByRole("region", { name: "Code review workspace" });
    await expect(review.getByRole("navigation", { name: "Changed files" })).toContainText(
      "file.ts",
    );
    await expect(review).toContainText("old value");
    await expect(review).toContainText("new value");
    await review
      .getByText("Working tree status (includes untracked files)", { exact: true })
      .click();
    await expect(review.locator("pre").last()).toContainText("M file.ts");
    await page.getByRole("button", { name: "Create review commit…", exact: true }).click();
    await expect(page.getByRole("region", { name: "Review commit preview" })).toContainText(
      "Potential secret",
    );
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.screenshot({
      path: `output/playwright/worktrees-review-${theme}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Integrate changes…", exact: true }).click();
    await expect(page.getByRole("region", { name: "Integration preview" })).toContainText(
      "/temporary/repository",
    );
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.evaluate(
      async ({ modulePath, theme }) => {
        const gallery = await import(modulePath);
        gallery.mountWorktreeGallery(theme, true);
      },
      { modulePath, theme },
    );
    await page.getByRole("button", { name: "Integrate changes…", exact: true }).click();
    await expect(
      page.getByText("The destination has local changes.", { exact: false }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.screenshot({
      path: `output/playwright/worktrees-error-${theme}.png`,
      fullPage: true,
    });
  });
}
