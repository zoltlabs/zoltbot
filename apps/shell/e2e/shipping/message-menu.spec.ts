import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

test("message menu and reactions work from the mouse and the keyboard", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");
    const answer = page.getByText("First answer").last();
    await expect(answer).toBeVisible({ timeout: 15_000 });
    const entry = page.locator(".message-entry-bot").filter({ has: answer });
    const toolbar = entry.getByRole("toolbar", { name: "Agent message actions" });

    // More opens the menu; Copy confirms with a toast and gives focus back to More.
    await answer.hover();
    const more = toolbar.getByRole("button", { name: "More message actions" });
    await more.click();
    const menu = page.getByRole("menu", { name: "Message actions" });
    await expect(menu.getByRole("menuitem", { name: "Reply" })).toBeFocused();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
    await expect(more).toBeFocused();

    // Right-click opens the same menu at the pointer; Reply starts a reply.
    await answer.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await answer.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Reply" }).click();
    await expect(page.getByText("Replying to Agent")).toBeVisible();

    // The emoji popover reacts and closes.
    await answer.hover();
    await toolbar.getByRole("button", { name: "Add reaction" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a reaction" });
    await expect(picker).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await picker.getByRole("button", { name: "React with 🎉" }).click();
    await expect(picker).toHaveCount(0);
    await expect(entry.getByRole("button", { name: "Remove reaction 🎉" })).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
