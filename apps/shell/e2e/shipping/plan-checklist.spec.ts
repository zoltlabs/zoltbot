import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("the agent's plan is pinned under the header and folds when it is done", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("Take time to write a checklist for the release notes");
    await composer.press("Enter");

    // While the turn runs the checklist is open on the step in progress.
    const plan = page.getByRole("region", { name: "Plan" });
    const toggle = plan.getByRole("button", { name: /^Plan/ });
    await expect(toggle).toContainText("2 of 3 done", { timeout: 15_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(plan.getByRole("listitem")).toHaveText([
      /Read the notes.*Done/,
      /Draft the summary.*Done/,
      /Check the links.*In progress/,
    ]);
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    // When the turn ends every step is done and the checklist folds to its progress line.
    await expect(toggle).toContainText("3 of 3 done", { timeout: 15_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(plan.getByRole("list")).toBeHidden();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(plan.getByRole("list")).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
