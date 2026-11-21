import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { handle } from "../../../../packages/core/src/index";
import { profileApi } from "../../../../packages/daemon/src/browser/profiles";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("an agent's kept browser profile shows in its settings and Clear signs it out", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // The owner allowed the agent to keep a profile, and it has been used once.
    const { store, dataDir } = fixture.daemon;
    const profiles = profileApi({ store, dataDir });
    const launch = { agentId: "profile", agentName: "Fixture", threadId: "thread" };
    profiles.forLaunch(launch);
    const card = store
      .snapshot(["interaction"])
      .interaction?.find((row) => String(row.id).startsWith("browser-profile:"));
    const at = new Date().toISOString();
    store.dispatch("allow-profile", (state) =>
      handle(
        state,
        {
          type: "answer",
          id: String(card?.id),
          version: 1,
          answer: {
            action: "accept",
            answers: { choice: { options: ["allow"] } },
            by: { kind: "human", id: "local-owner" },
            at,
          },
        },
        { commandId: "allow-profile", at, actor: { kind: "human", id: "local-owner" } },
      ),
    );
    const folder = profiles.forLaunch(launch)?.dir ?? "";
    expect(existsSync(folder)).toBe(true);

    await shell.service.createBot({ profileId: "profile", title: "Research" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Research/ })
      .click();
    await page.getByRole("button", { name: "View agent settings" }).click();

    const clear = page.getByRole("button", { name: "Clear browser profile" });
    await clear.scrollIntoViewIfNeeded();
    await expect(page.getByText("Signed in", { exact: true })).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/b1-settings-${scheme}.png` });
    }

    // Cancel keeps it and returns focus to Clear.
    await clear.click();
    const dialog = page.getByRole("alertdialog", { name: "Clear browser profile?" });
    await expect(dialog).toContainText("Research will be signed out of every site.");
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/b1-confirm-${scheme}.png` });
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(clear).toBeFocused();
    expect(existsSync(folder)).toBe(true);

    await clear.click();
    await dialog.getByRole("button", { name: "Clear" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Signed in", { exact: true })).toBeHidden();
    expect(existsSync(folder)).toBe(false);
    expect(store.snapshot(["audit"]).audit).toContainEqual(
      expect.objectContaining({ action: "browser.profile.clear", target: "profile" }),
    );
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
