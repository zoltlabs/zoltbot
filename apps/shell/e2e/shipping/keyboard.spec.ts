import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

test("Keyboard lists shortcuts, refuses a used combination and saves a new one", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Keyboard" }).click();
    const dialog = page.getByRole("dialog", { name: "Keyboard" });
    await expect(dialog).toContainText("Show or hide Tasks");
    expect(await axeViolations(page)).toEqual([]);

    await dialog.getByRole("button", { name: "Change Show or hide Tasks" }).click();
    await expect(dialog).toContainText("Press keys");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(dialog.getByRole("alert")).toHaveText("Already used by Search or run a command");
    // The palette didn't open: the press went to the recorder.
    await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+Shift+Y");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    const reset = dialog.getByRole("button", { name: "Reset Show or hide Tasks" });
    await expect(reset).toBeVisible();
    await expect
      .poll(() => page.evaluate(async () => (await window.openbot.preferences?.get())?.keyBindings))
      .toEqual({ "app.tasks": "Mod+Shift+Y" });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d11-keyboard.png` });

    await reset.click();
    await expect(reset).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(async () => (await window.openbot.preferences?.get())?.keyBindings))
      .toEqual({});
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
