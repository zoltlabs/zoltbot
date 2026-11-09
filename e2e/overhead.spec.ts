import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, showConversationDetails } from "./desktop.js";

test("shows turn and session overhead without inventing missing provider input or cache counts", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await showConversationDetails(page);
    const meter = page.getByRole("region", { name: "Added context", exact: true });
    await meter.getByText("Overhead details", { exact: true }).click();
    const latest = meter.getByRole("region", { name: "Current or latest turn", exact: true });
    await expect(latest).toContainText("Not reported");
    const editor = page.getByRole("textbox", { name: "Message Builder", exact: true });
    await editor.fill("usage");
    await editor.press("Enter");
    await expect(latest.getByText("10 tokens", { exact: true })).toBeVisible();
    await expect(latest.getByText("80%", { exact: true })).toBeVisible();
    await expect(latest.getByText("0%", { exact: true })).toBeVisible();
    const session = meter.getByRole("region", { name: "Current session", exact: true });
    await expect(session.getByText("10 tokens", { exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/overhead-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await showConversationDetails(page);
    await meter.getByText("Overhead details", { exact: true }).click();
    await page.screenshot({ path: "output/playwright/overhead-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await editor.fill("no usage sample");
    await editor.press("Enter");
    await expect(latest.getByText("Not reported", { exact: true })).toHaveCount(3);
    await expect(session.getByText("Not reported", { exact: true })).toHaveCount(3);
    await expect(session.getByText("0 tokens", { exact: true })).toBeVisible();
    await meter.getByText("Overhead details", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(latest).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(latest).toBeVisible();
    await page.setViewportSize({ width: 900, height: 900 });
    const compact = page.getByRole("region", { name: "Added context", exact: true });
    await compact.getByText("Overhead details", { exact: true }).click();
    await expect(
      compact.getByRole("region", { name: "Current session", exact: true }),
    ).toBeHidden();
    await compact.getByText("Overhead details", { exact: true }).click();
    await expect(
      compact.getByRole("region", { name: "Current session", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "output/playwright/overhead-narrow-dark.png", fullPage: true });
  } finally {
    await fixture.cleanup();
  }
});
