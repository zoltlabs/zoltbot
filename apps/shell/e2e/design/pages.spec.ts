import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";
import { layoutProblems, overlayTriggers, triggerProblems, WINDOW_SIZES } from "./checks";
import { KNOWN_PROBLEMS } from "./known-problems";

/**
 * The app's main pages, each opened from the sidebar. Every page is checked at three window
 * sizes in both themes for layout problems, and every menu, list or dialog it can open is
 * opened, checked and closed.
 */
const PAGES: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: "chat",
    open: async (page) => {
      await sidebar(page)
        .getByRole("button", { name: /^Release notes/ })
        .click();
      await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: "tasks",
    open: async (page) => {
      await sidebar(page).getByRole("button", { name: "Tasks", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Tasks" }).first()).toBeVisible();
    },
  },
  {
    name: "models",
    open: async (page) => {
      await sidebar(page).getByRole("button", { name: "Models", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Models" }).first()).toBeVisible();
    },
  },
  {
    name: "map",
    open: async (page) => {
      await sidebar(page).getByRole("button", { name: "Map", exact: true }).click();
      await expect(page.getByText("The command map isn't installed.")).toBeVisible();
    },
  },
];

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "Bot navigation" });
}

/** Drops problems listed in known-problems.ts, each of which has a planned fix. */
function unexpected(page: string, problems: string[]) {
  return problems.filter(
    (problem) =>
      !KNOWN_PROBLEMS.some(
        (known) => (known.page === "*" || known.page === page) && problem.includes(known.match),
      ),
  );
}

test("every page passes the layout and overlay checks", async ({ page }) => {
  test.setTimeout(600_000);
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createProject(mkdtempSync(join(tmpdir(), "example-project-")));
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await sidebar(page)
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");

    const report: string[] = [];
    for (const target of PAGES) {
      await page.setViewportSize(WINDOW_SIZES[1]);
      await settleColorScheme(page, "dark");
      await target.open(page);
      for (const trigger of await overlayTriggers(page)) {
        const problems = await triggerProblems(page, trigger.locator, trigger.name);
        report.push(...unexpected(target.name, problems).map((line) => `${target.name}: ${line}`));
        // Put the page back the way it was, in case the overlay changed it.
        await page.keyboard.press("Escape");
      }
      for (const size of WINDOW_SIZES) {
        await page.setViewportSize(size);
        for (const scheme of COLOR_SCHEMES) {
          await settleColorScheme(page, scheme);
          const problems = unexpected(target.name, await layoutProblems(page));
          const where = `${target.name} ${size.width}×${size.height} ${scheme}`;
          report.push(...problems.map((line) => `${where}: ${line}`));
        }
      }
    }
    expect(report).toEqual([]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
