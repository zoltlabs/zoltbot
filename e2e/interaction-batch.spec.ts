import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";

test("reviews recommended answers before a batch send and confirms skipping unsupported selections", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("single_question");
    await editor.press("Enter");
    await expect(page.getByRole("radio", { name: "A Recommended", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select Chat verification", exact: true }).check();
    await page.getByRole("button", { name: "Review recommended", exact: true }).click();
    const review = page.getByRole("region", { name: "Review batch answers", exact: true });
    await expect(
      review.getByRole("heading", { name: "Review recommended answers", exact: true }),
    ).toBeFocused();
    await expect(review.getByText("A", { exact: true })).toBeVisible();
    if ((await page.locator("html").getAttribute("data-theme")) !== "light")
      await page.getByRole("button", { name: "Use light theme", exact: true }).click();
    await page.screenshot({ path: "output/playwright/inbox-batch-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "output/playwright/inbox-batch-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await review.getByRole("button", { name: "Back to requests", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Review recommended", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Review recommended", exact: true }).click();
    await review.getByRole("button", { name: "Send recommended answers", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Select Chat verification", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await expect(editor).toBeVisible();
    await editor.fill("question");
    await editor.press("Enter");
    await expect(page.getByRole("radio", { name: "A Recommended", exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "A Recommended", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select Chat verification", exact: true }).check();
    await expect(
      page.getByRole("button", { name: "Review recommended", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Skip selected", exact: true }).click();
    await expect(
      review.getByRole("heading", { name: "Skip selected requests", exact: true }),
    ).toBeFocused();
    await review.getByRole("button", { name: "Confirm skip", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Select Chat verification", exact: true }),
    ).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});
