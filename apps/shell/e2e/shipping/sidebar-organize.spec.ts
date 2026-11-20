import { expect, type Locator, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/**
 * Ported from tests/shipping/chat-actions.spec.ts (S9): pin, unread marks and archive from a
 * chat's row menu, and the sidebar's sort menu.
 */
async function choose(page: Page, row: Locator, item: string) {
  await row.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Agent actions" })
    .getByRole("menuitem", { name: item })
    .click();
}

async function above(first: Locator, second: Locator) {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  return Boolean(a && b && a.y < b.y);
}

test("chats pin, mark unread and read, archive with Undo, and sort by name", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const alpha = await shell.service.createBot({ profileId: "profile", title: "Alpha chat" });
    const beta = await shell.service.createBot({ profileId: "profile", title: "Beta chat" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const alphaRow = sidebar.getByRole("button", { name: /^Alpha chat(?: |$)/ });
    const betaRow = sidebar.getByRole("button", { name: /^Beta chat(?: |$)/ });
    await expect(alphaRow).toBeVisible();
    await expect(betaRow).toBeVisible();
    const record = (id: string) => fixture.daemon.store.record("thread", id);

    // Pin keeps a chat first among the chats.
    await choose(page, alphaRow, "Pin");
    await expect.poll(() => record(alpha.id)?.pinned).toBe(true);
    await expect.poll(() => above(alphaRow, betaRow)).toBe(true);

    // Mark unread moves a chat that isn't open under Unread at the top; Mark read puts it back.
    // The open chat keeps its place until the owner leaves it, so open Alpha first.
    await alphaRow.click();
    await choose(page, betaRow, "Mark unread");
    await expect.poll(() => record(beta.id)?.wakeUnreadAt).toBeTruthy();
    const unread = sidebar.getByText("Unread", { exact: true });
    await expect(unread).toBeVisible();
    await expect.poll(() => above(betaRow, alphaRow)).toBe(true);
    await betaRow.click({ button: "right" });
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("menuitem", { name: "Mark read" }).click();
    await expect(unread).toHaveCount(0);

    // Archive hides the chat; Undo brings it back.
    await choose(page, betaRow, "Archive");
    await expect(betaRow).toHaveCount(0);
    await expect.poll(() => record(beta.id)?.archived).toBe(true);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(betaRow).toBeVisible();
    await expect.poll(() => record(beta.id)?.archived).toBe(false);

    // Sort by name, after unpinning, puts Alpha above Beta and is remembered.
    await choose(page, alphaRow, "Unpin");
    await expect.poll(() => record(alpha.id)?.pinned).toBe(false);
    await sidebar.getByRole("button", { name: "Sort and filter" }).click();
    const sortMenu = page.getByRole("menu", { name: "Sort and filter" });
    expect(await axeViolations(page)).toEqual([]);
    await sortMenu.getByRole("menuitemradio", { name: "Name" }).click();
    await expect.poll(() => above(alphaRow, betaRow)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("zoltbot.sidebar.sort"))).toBe("name");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
