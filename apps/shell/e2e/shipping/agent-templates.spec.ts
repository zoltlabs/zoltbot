import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/**
 * Axe on the open dialog in both themes. The page behind it is left out: with the agent picker
 * open, the disabled composer's placeholder already fails contrast before this feature.
 */
async function dialogViolations(page: Page) {
  const lines: string[] = [];
  for (const scheme of COLOR_SCHEMES) {
    await settleColorScheme(page, scheme);
    const result = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    for (const violation of result.violations) lines.push(`${scheme} ${violation.id}`);
  }
  return lines;
}

/** Saves the dialog in both themes when ZOLTBOT_SHOTS names a folder, for design review. */
async function shots(page: Page, name: string) {
  const folder = process.env.ZOLTBOT_SHOTS;
  if (!folder) return;
  for (const scheme of COLOR_SCHEMES) {
    await settleColorScheme(page, scheme);
    await page.screenshot({ path: `${folder}/${name}-${scheme}.png` });
  }
}

test("New agent offers templates; picking one fills the form and creates the agent", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("option", { name: "Create new agent" }).click();

    const dialog = page.getByRole("dialog", { name: "New agent" });
    const gallery = dialog.getByRole("list", { name: "Templates" });
    await expect(gallery.getByRole("button")).toHaveCount(17);
    await expect(gallery.getByRole("button").first()).toHaveText("Start blank");
    await expect(gallery.getByRole("button", { name: /^Code reviewer/ })).toContainText(
      "Reviews changes for bugs and risks",
    );
    // Focus starts on the first card, with a visible ring once the keyboard is used.
    await expect(gallery.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(gallery.getByRole("button").first()).toBeFocused();
    expect(
      await gallery
        .getByRole("button")
        .first()
        .evaluate((element) => getComputedStyle(element).outlineStyle),
    ).toBe("solid");
    // Every card fits at the default window size.
    await expect(gallery.getByRole("button", { name: /^Project manager/ })).toBeInViewport({
      ratio: 1,
    });
    // Cards show the name and role only; instructions appear after picking.
    await expect(dialog).not.toContainText("You review code changes");
    expect(await dialogViolations(page)).toEqual([]);
    await shots(page, "a1-gallery");

    await gallery.getByRole("button", { name: /^Code reviewer/ }).click();
    const name = dialog.getByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue("Code reviewer");
    await expect(name).toBeFocused();
    await expect(dialog.getByRole("textbox", { name: "Role" })).toHaveValue(
      "Reviews changes for bugs and risks",
    );
    await expect(dialog.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      /You review code changes/,
    );
    expect(await dialogViolations(page)).toEqual([]);
    await shots(page, "a1-form");

    // Back returns to the gallery without losing it.
    await dialog.getByRole("button", { name: "Back" }).click();
    await expect(gallery).toBeVisible();
    await gallery.getByRole("button", { name: /^Code reviewer/ }).click();

    await name.fill("Rita");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Rita" })).toBeVisible();

    const profile = shell.service.client.rows("agent").find((row) => row.name === "Rita");
    expect(profile).toMatchObject({
      templateId: "code-reviewer",
      roleText: "Reviews changes for bugs and risks",
      kind: "profile",
    });
    expect(String(profile?.instructions)).toContain("You review code changes");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});

test("Start blank creates an agent the old way", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("option", { name: "Create new agent" }).click();
    const live = () => shell.service.client.rows("thread").filter((row) => !row.archived).length;
    const before = live();
    await page.getByRole("button", { name: "Start blank" }).click();
    await expect(page.getByRole("dialog", { name: "New agent" })).toHaveCount(0);
    await expect.poll(live).toBe(before + 1);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
