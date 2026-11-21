import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("Back and Forward move through chats and pages, with the arrows, keys and mouse", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.service.createBot({ profileId: "profile", title: "Bug triage" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const back = page.getByRole("button", { name: "Back", exact: true });
    const forward = page.getByRole("button", { name: "Forward", exact: true });
    const releaseNotes = page.getByRole("textbox", { name: "Message Release notes" });
    const bugTriage = page.getByRole("textbox", { name: "Message Bug triage" });

    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    await expect(releaseNotes).toBeVisible();
    await sidebar.getByRole("button", { name: /^Bug triage/ }).click();
    await expect(bugTriage).toBeVisible();
    await sidebar.getByRole("button", { name: "Models" }).click();
    await expect(page.getByRole("heading", { name: "Models" }).first()).toBeVisible();
    await expect(forward).toBeDisabled();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await back.click();
    await expect(bugTriage).toBeVisible();
    await expect(forward).toBeEnabled();

    // Command-[ works from the composer too.
    await bugTriage.click();
    await page.keyboard.press("ControlOrMeta+BracketLeft");
    await expect(releaseNotes).toBeVisible();

    await page.keyboard.press("ControlOrMeta+BracketRight");
    await expect(bugTriage).toBeVisible();

    // The mouse's forward button.
    await page.mouse.move(400, 300);
    await page.evaluate(() =>
      window.dispatchEvent(new MouseEvent("mouseup", { button: 4, bubbles: true })),
    );
    await expect(page.getByRole("heading", { name: "Models" }).first()).toBeVisible();
    await expect(forward).toBeDisabled();

    // The arrows stay on screen with the sidebar hidden.
    await sidebar.getByRole("button", { name: "Hide sidebar" }).click();
    await back.click();
    await expect(bugTriage).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
