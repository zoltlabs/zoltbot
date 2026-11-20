import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Selects the first `length` characters of the agent's answer, like a drag or Shift-arrow. */
async function selectAnswer(page: Page, length: number) {
  await page.evaluate((count) => {
    const copy = [...document.querySelectorAll(".message-entry-bot .message-copy")].at(-1);
    const walker = copy && document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    const node = walker?.nextNode();
    if (!node) throw Error("No answer text");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, count);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, length);
}

test("Ask about this quotes selected words into the composer", async ({ page }) => {
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
    await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".bot-bubble-streaming")).toHaveCount(0, { timeout: 15_000 });

    // ⌘L quotes the selection and puts the caret in the composer.
    await selectAnswer(page, 5);
    const button = page.getByRole("button", { name: "Ask about this" });
    await expect(button).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Meta+L");
    await expect(composer).toBeFocused();
    await expect(composer).toContainText("> First");
    await expect(button).toHaveCount(0);
    await page.keyboard.type("Which one?");

    // The button does the same, adding below what is already written.
    await selectAnswer(page, 12);
    await button.click();
    await expect(composer).toBeFocused();
    await expect(composer).toContainText("Which one?");
    await expect(composer).toContainText("> First answer");

    // Nothing selected: ⌘L does nothing.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(button).toHaveCount(0);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
