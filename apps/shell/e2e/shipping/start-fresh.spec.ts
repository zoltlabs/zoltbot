import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

test("Start fresh asks for the typed phrase, lists kept project folders and restarts", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // Main's half deletes data and relaunches: the test stands in for it and records the calls.
    await page.addInitScript(() => {
      const calls: string[] = [];
      (window as unknown as { calls: string[] }).calls = calls;
      const fresh = {
        run: async (confirm: string) => {
          calls.push(`run:${confirm}`);
          return { kept: ["/Projects/site/.zoltbot"] };
        },
        restart: async () => {
          calls.push("restart");
        },
      };
      let api: { fresh?: unknown } | undefined;
      Object.defineProperty(window, "openbot", {
        configurable: true,
        get: () => api,
        set: (value) => {
          api = value;
          if (api) api.fresh = fresh;
        },
      });
    });
    await shell.open(page);
    const calls = () => page.evaluate(() => (window as unknown as { calls: string[] }).calls);

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Start fresh…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Start fresh?" });
    await expect(dialog).toContainText("Your project folders stay.");
    const confirm = dialog.getByRole("button", { name: "Start fresh" });
    await expect(confirm).toBeDisabled();
    const field = dialog.getByRole("textbox", { name: 'Type "start fresh" to confirm' });
    await expect(field).toBeFocused();
    await field.fill("start");
    await expect(confirm).toBeDisabled();
    await field.fill("start fresh");
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d6-confirm.png` });
    await confirm.click();

    const kept = page.getByRole("dialog", {
      name: "Delete these folders in your projects by hand",
    });
    await expect(kept).toContainText("/Projects/site/.zoltbot");
    // Past the point of no return, Escape doesn't close it.
    await page.keyboard.press("Escape");
    await expect(kept).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d6-kept.png` });
    await kept.getByRole("button", { name: "Restart" }).click();
    await expect.poll(calls).toEqual(["run:start fresh", "restart"]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
