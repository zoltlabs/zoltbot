import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, showActivity, showConversationDetails } from "./desktop.js";

test("connects without a prompt and recovers native authentication and crash status", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const status = page.getByRole("region", { name: "Conversation status", exact: true });
    await expect(status).toContainText("Your coding tool starts when you send a message.");
    await status.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(status).toHaveCount(0);
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect(page.getByText("native turn", { exact: false })).toHaveCount(0);
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("auth_required");
    await editor.press("Enter");
    await expect(status).toContainText("Not signed in");
    await showConversationDetails(page);
    await expect(page.getByRole("button", { name: "Compact now", exact: true })).toBeDisabled();
    await expect(page.getByText("synthetic-private-auth-detail", { exact: false })).toHaveCount(0);
    await page.screenshot({ path: "output/playwright/chat-auth.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await status.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(status).toHaveCount(0);
    await editor.fill("crash");
    await editor.press("Enter");
    await expect(status).toContainText("Coding tool stopped unexpectedly");
    await showActivity(page);
    await expect(page.locator(".chat-request")).toContainText("Expired");
    await expect(page.locator(".chat-request")).not.toContainText("Needs you");
    await expect(page.getByRole("article", { name: "Tool Read", exact: true })).toContainText(
      "unconfirmed",
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await expect(status).toContainText("Coding tool stopped unexpectedly");
    await page.screenshot({ path: "output/playwright/chat-crash-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await status.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(status).toHaveCount(0);
    await editor.fill("usage");
    await editor.press("Enter");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeAttached();
    await page.locator("details.message-details").last().locator(":scope > summary").click();
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});
