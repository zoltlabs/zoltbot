import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import de from "../../src/renderer/src/i18n/de.json" with { type: "json" };
import ja from "../../src/renderer/src/i18n/ja.json" with { type: "json" };
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

/** Nothing on the page is wider than the window. */
const overflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

/**
 * Text cut off inside dialogs and menus: an element whose text is wider than its box, unless it
 * scrolls or ends in an ellipsis on purpose.
 */
const clipped = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] *, [role="alertdialog"] *, [role="menu"] *')]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => {
        if (!element.textContent?.trim() || element.children.length > 0) return false;
        const style = getComputedStyle(element);
        if (style.textOverflow === "ellipsis" || /auto|scroll/.test(style.overflowX)) return false;
        return element.scrollWidth > element.clientWidth + 1 && style.overflowX === "hidden";
      })
      .map((element) => element.textContent?.trim()),
  );

test("Languages: German at the largest text size fits, and the choice is saved", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Appearance" }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    await dialog.getByRole("button", { name: /^Language/ }).click();
    await page.getByRole("option", { name: "Deutsch", exact: true }).click();

    // The dialog changes language at once.
    const german = page.getByRole("dialog", { name: de["appearance.title"] });
    await expect(german).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("de");
    await german.getByRole("button", { name: new RegExp(`^${de["appearance.textSize"]}`) }).click();
    await page.getByRole("option", { name: de["appearance.size.larger"], exact: true }).click();

    // At 1.25 a 1280-wide window lays out like a 1024-wide page.
    const size = page.viewportSize() ?? { width: 1280, height: 820 };
    await page.setViewportSize({
      width: Math.round(size.width / 1.25),
      height: Math.round(size.height / 1.25),
    });
    expect(await overflows(page)).toBe(false);
    expect(await clipped(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d9-de-appearance.png` });
    await german.getByRole("button", { name: de["appearance.done"] }).click();

    // Every dialog in the account menu, in German. (The menu's own button isn't in the catalog
    // yet: F5.)
    for (const [item, title] of [
      [de["sounds.title"], de["sounds.title"]],
      [de["keyboard.title"], de["keyboard.title"]],
      [de["move.title"], de["move.title"]],
      [de["fresh.open"], de["fresh.title"]],
    ] as const) {
      await page.getByRole("button", { name: "Open account menu" }).click();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/d9-de-menu.png` });
      expect(await clipped(page), "menu").toEqual([]);
      await page.getByRole("menu").getByRole("menuitem", { name: item }).click();
      const open = page
        .getByRole("dialog", { name: title })
        .or(page.getByRole("alertdialog", { name: title }));
      await expect(open).toBeVisible();
      expect(await overflows(page), title).toBe(false);
      expect(await clipped(page), title).toEqual([]);
      expect(await axeViolations(page), title).toEqual([]);
      if (SHOTS)
        await page.screenshot({ path: `${SHOTS}/d9-de-${title.replace(/\W+/g, "-")}.png` });
      await page.keyboard.press("Escape");
      await expect(open).toBeHidden();
    }
    expect(await overflows(page)).toBe(false);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d9-de-chat.png` });
    await page.setViewportSize(size);

    // Saved: a reload keeps German. Japanese breaks lines by its own rules.
    await page.reload();
    await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: de["sidebar.account.appearance"] })
      .click();
    await page
      .getByRole("dialog", { name: de["appearance.title"] })
      .getByRole("button", { name: new RegExp(`^${de["appearance.language"]}`) })
      .click();
    await page.getByRole("option", { name: "日本語", exact: true }).click();
    await expect(page.getByRole("dialog", { name: ja["appearance.title"] })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).lineBreak)).toBe("strict");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d9-ja-appearance.png` });
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
