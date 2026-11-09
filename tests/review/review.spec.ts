import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("review navigation, provenance, scope, display and bounded rendering", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("http://127.0.0.1:5193/tests/review/");
  await expect(page.getByRole("heading", { name: "src/main.ts" })).toBeVisible();
  await expect(page.getByText(/does not identify individual turn changes/)).toBeVisible();
  await page.getByLabel("Display").selectOption("split");
  await expect(page.locator(".review-split")).toBeVisible();
  await page.getByRole("button", { name: /image.bin/ }).click();
  await expect(page.getByText("Binary content is not displayed.")).toBeVisible();
  await page.getByRole("button", { name: /large.ts/ }).click();
  await expect(page.locator(".tool-diff-line")).toHaveCount(400);
  await page.getByRole("button", { name: /Next 400 lines/ }).click();
  await expect(page.getByRole("button", { name: "Previous lines" })).toBeVisible();
  await expect(page.locator(".tool-diff-line")).toHaveCount(400);
  await page.getByLabel("Filter files").fill("missing");
  await expect(page.getByText("No files match “missing”.")).toBeVisible();
  await page.getByLabel("Filter files").fill("");
  await page.getByLabel("Compare").selectOption("head");
  await expect(page.getByRole("heading", { name: "src/local.ts" })).toBeVisible();
  await page.getByLabel("Review feedback for this task").fill("Please add a regression test.");
  await expect(page.getByRole("button", { name: "Copy feedback for conversation" })).toBeEnabled();
  await page.getByRole("button", { name: "Copy feedback for conversation" }).click();
  await expect(
    page.getByText("Copied. Open the task conversation and paste to send."),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "HEAD head-revision → working tree, file src/local.ts",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "src/local.ts" })).toBeVisible();
});

test("design review: themes, keyboard focus and 320px reflow", async ({ page }) => {
  await page.goto("http://127.0.0.1:5193/tests/review/");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ path: `output/review-design-${theme}.png`, fullPage: true });
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus-visible")).toHaveCount(1);
    await page.getByLabel("Compare").focus();
    await page.keyboard.press("h");
    await page.keyboard.press("Enter");
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.screenshot({ path: "output/review-design-narrow.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByRole("button", { name: "Copy feedback for conversation" })).toBeVisible();
});
