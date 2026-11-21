import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("Continue unfinished replies is on by default and turns off per agent", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  // The test daemon doesn't push events to the app, so read the setting from the daemon.
  const stored = async () =>
    (
      (await shell.service.client.call("settings.get", {})) as { key: string; value: unknown }[]
    ).find((row) => row.key === "agent.continue.profile")?.value;
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    await page.getByRole("button", { name: "View agent settings" }).click();

    const toggle = page.getByRole("switch", { name: "Continue unfinished replies" });
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAccessibleDescription(/ends with a plan/);
    await toggle.click();
    await expect.poll(stored).toBe(false);
    await expect(toggle).not.toBeChecked();

    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await toggle.click();
    await expect.poll(stored).toBe(true);
    await expect(toggle).toBeChecked();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
