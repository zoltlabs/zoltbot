import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openKitGallery } from "../bridge";
import { axeViolations, COLOR_SCHEMES, settleColorScheme } from "../harness";
import { expectFullyVisible } from "./checks";

/** Opens an overlay from `trigger`, checks it, closes it with Escape and checks focus returns. */
async function checkOverlay(page: Page, trigger: Locator, name: string) {
  await trigger.click();
  const overlay = page.locator("[data-kit-overlay]").last();
  await expectFullyVisible(page, overlay, name);
  await page.keyboard.press("Escape");
  await expect(overlay, `${name} closes on Escape`).toBeHidden();
  await expect(trigger, `${name} returns focus`).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await openKitGallery(page);
  await expect(page.getByRole("heading", { name: "Kit gallery" })).toBeVisible();
});

for (const size of [
  { width: 960, height: 640 },
  { width: 1280, height: 820 },
]) {
  test(`menus at every window edge stay fully visible at ${size.width}×${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    for (const name of ["Top left", "Top right", "Bottom left", "Bottom right"])
      await checkOverlay(page, page.getByRole("button", { name, exact: true }), `menu ${name}`);
  });
}

test("a menu opened at a point in the corner flips and shifts on screen", async ({ page }) => {
  await page.getByRole("button", { name: "Right-click in the corner" }).click();
  await expectFullyVisible(
    page,
    page.getByRole("menu", { name: "Message actions" }),
    "corner menu",
  );
  await page.keyboard.press("Escape");
});

test("pickers inside a clipped scrolling panel open fully visible", async ({ page }) => {
  const panel = page.getByRole("region", { name: "Clipped panel" });
  await checkOverlay(page, panel.getByRole("button", { name: /^Reasoning:/ }), "select");
  await checkOverlay(page, panel.getByRole("button", { name: /^Model:/ }), "combobox");
});

test("a short window caps the menu height and scrolls inside it", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 220 });
  const trigger = page.getByRole("button", { name: "Top left", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Message actions" });
  await expectFullyVisible(page, menu, "short window menu");
  const scrolls = await menu.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrolls).toBe(true);
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Hide" })).toBeInViewport();
});

test("popover, dialog, tooltip and toast are fully visible and dismissable", async ({ page }) => {
  await checkOverlay(page, page.getByRole("button", { name: "Popover" }), "popover");
  await checkOverlay(page, page.getByRole("button", { name: "Delete agent" }), "dialog");

  await page.getByRole("button", { name: "Copy" }).hover();
  await expectFullyVisible(page, page.getByRole("tooltip"), "tooltip");

  await page.getByRole("button", { name: "Archive" }).click();
  await expectFullyVisible(
    page,
    page.getByRole("status").filter({ hasText: "Ada archived" }),
    "toast",
  );
});

test("the gallery passes axe in both themes with overlays open", async ({ page }) => {
  expect(await axeViolations(page), "closed").toEqual([]);
  await page.getByRole("button", { name: "Top left", exact: true }).click();
  expect(await axeViolations(page), "menu open").toEqual([]);
  await page.keyboard.press("Escape");
  await page
    .getByRole("region", { name: "Clipped panel" })
    .getByRole("button", { name: /^Model:/ })
    .click();
  expect(await axeViolations(page), "combobox open").toEqual([]);
  await page.keyboard.press("Escape");
  await page
    .getByRole("region", { name: "Clipped panel" })
    .getByRole("button", { name: /^Reasoning:/ })
    .click();
  expect(await axeViolations(page), "select open").toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Delete agent" }).click();
  expect(await axeViolations(page), "dialog open").toEqual([]);
});

/** Screenshots of the kit for review, in both themes. The folder is ignored by git. */
test("saves kit screenshots in both themes", async ({ page }) => {
  const folder = fileURLToPath(new URL("../../../../output/kit/", import.meta.url));
  const panel = page.getByRole("region", { name: "Clipped panel" });
  const shots: [string, () => Promise<void>][] = [
    ["menu", () => page.getByRole("button", { name: "Top left", exact: true }).click()],
    ["select", () => panel.getByRole("button", { name: /^Reasoning:/ }).click()],
    ["combobox", () => panel.getByRole("button", { name: /^Model:/ }).click()],
    ["dialog", () => page.getByRole("button", { name: "Delete agent" }).click()],
    ["toast", () => page.getByRole("button", { name: "Archive" }).click()],
  ];
  for (const scheme of COLOR_SCHEMES) {
    await settleColorScheme(page, scheme);
    for (const [name, open] of shots) {
      await open();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(folder, `${name}-${scheme}.png`) });
      await page.keyboard.press("Escape");
    }
  }
});
