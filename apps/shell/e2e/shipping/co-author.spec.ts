import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("A project's agents are named in commits until the owner turns it off", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  const folder = mkdtempSync(path.join(tmpdir(), "co-author-"));
  try {
    await shell.rpc.call(
      "project.create",
      {
        value: {
          id: "web",
          name: "Web",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [{ path: folder, label: "Web", repoRoot: folder }],
          hierarchyDepth: 1,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: new Date().toISOString(),
        },
      },
      "create-web",
    );
    await shell.service.createBot({
      profileId: "profile",
      title: "Release notes",
      projectId: "web",
    });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    await page.getByRole("button", { name: "View agent settings" }).click();

    const toggle = page.getByRole("switch", { name: "Credit agents in commits" });
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAccessibleDescription("Applies to every agent in this project");
    await toggle.scrollIntoViewIfNeeded();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/a4-settings-${scheme}.png` });
    }

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(() => fixture.daemon.store.record("project", "web")?.coAuthorLine)
      .toBe(false);
    await toggle.click();
    await expect.poll(() => fixture.daemon.store.record("project", "web")?.coAuthorLine).toBe(true);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
