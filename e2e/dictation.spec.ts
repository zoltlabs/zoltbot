import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, showMessageDetails } from "./desktop.js";

test("dictates into chat composer, supports Escape rollback, edits transcript, and sends an ordinary message", async () => {
  const fixture = await launch("chat");
  const { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("Prefix:");

    // Start dictation and verify live partial hypothesis is inserted after Prefix:
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await expect(page.getByRole("group", { name: "Active dictation", exact: true })).toBeVisible();
    await expect(editor).toHaveValue("Prefix: spoken draft for Builder");

    // Pressing Escape while listening cancels and restores the exact pre-dictation draft
    await editor.press("Escape");
    await expect(page.getByRole("group", { name: "Active dictation", exact: true })).toHaveCount(0);
    await expect(editor).toHaveValue("Prefix:");

    // Start dictation again, finalize with Done, edit the transcript, and send
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await expect(editor).toHaveValue("Prefix: spoken draft for Builder");
    await page.getByRole("button", { name: "Finish dictation", exact: true }).click();
    await expect(page.getByRole("group", { name: "Active dictation", exact: true })).toHaveCount(0);
    await expect(editor).toHaveValue("Prefix: spoken final for Builder");

    // Edit the finalized transcript and send as an ordinary message
    await editor.fill("usage");
    await editor.press("Enter");
    await showMessageDetails(page, "Reported $0.0010");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();

    // Verify Voice and dictation settings in light and dark modes with axe
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Voice and dictation", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Dictation readiness", { exact: true })).toContainText(
      "Ready · On-device recognition (en-US)",
    );

    await page.getByRole("button", { name: "Test dictation", exact: true }).click();
    const practice = page.getByLabel("Practice dictation", { exact: true });
    await expect(practice).toHaveValue("spoken draft for workspace");
    await page.getByRole("button", { name: "Finish dictation", exact: true }).click();
    await expect(practice).toHaveValue("spoken final for workspace");

    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});
