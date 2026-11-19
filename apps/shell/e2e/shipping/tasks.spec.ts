import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Waits for rows that just moved between groups to finish fading in. */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
}

/**
 * The Tasks page lists what needs the person, what runs and what waits. One employee runs two
 * tasks at once, so its third task waits at the limit, and the sidebar folds its task chats into
 * one row. Accept and Send back move a review at once.
 */
test("tasks page groups work, shows the running limit and reviews tasks", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // A project without a folder, so tasks never wait on each other's folder.
    const projectId = "launch";
    await shell.rpc.call(
      "project.create",
      {
        value: {
          id: projectId,
          name: "Launch",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 1,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: new Date().toISOString(),
        },
      },
      "create-launch",
    );
    await shell.service.createBot({ projectId, manager: true });
    await shell.open(page);
    await expect(page.getByRole("button", { name: /CEO/ }).first()).toBeVisible();

    await page.keyboard.press("Meta+t");
    const tasks = page.getByRole("main", { name: "Tasks" });
    await expect(tasks.getByRole("heading", { name: "Tasks · Launch" })).toBeFocused();
    await expect(tasks.getByText("No tasks yet.", { exact: false })).toBeVisible();

    const create = (title: string, brief: string, profileId = "profile") =>
      shell.rpc.call(
        "task.create",
        { title, brief, profileId, node: { type: "project", id: projectId } },
        `task:${title}`,
      );
    await create("Write the changelog", "Take time on the changelog");
    await create("Draft the announcement", "Take time on the announcement");
    await create("Update the docs", "Take time on the docs");
    await create("Check the links", "Check every link", "second");

    const group = (name: RegExp) => tasks.getByRole("region", { name });
    await expect(group(/^Running/).getByText("Write the changelog")).toBeVisible();
    await expect(group(/^Running/).getByText("Draft the announcement")).toBeVisible();
    await expect(group(/^Queued/).getByText("Queued · at limit")).toBeVisible();
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const employee = sidebar.getByRole("button", { name: /First.*2 running · 1 queued/ });
    await expect(employee).toBeVisible();
    await employee.click();
    await expect(employee).toHaveAttribute("aria-expanded", "true");
    await expect(
      sidebar.getByRole("list", { name: "First's tasks" }).getByRole("button"),
    ).toHaveCount(3);
    await settle(page);
    expect(await axeViolations(page)).toEqual([]);

    // The first two finish into review; the third starts once one of them stops running.
    const needsYou = group(/^Needs you/);
    await expect(needsYou.getByRole("button", { name: "Accept Write the changelog" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(sidebar.getByRole("button", { name: /^Tasks/ })).toContainText("need you");
    await needsYou.getByRole("button", { name: "Accept Write the changelog" }).click();
    await expect(needsYou.getByText("Write the changelog")).toHaveCount(0);
    await expect(group(/^Done/)).toContainText("Done · ");

    await expect(
      needsYou.getByRole("button", { name: "Send back Draft the announcement" }),
    ).toBeVisible({ timeout: 15_000 });
    await needsYou.getByRole("button", { name: "Send back Draft the announcement" }).click();
    await tasks.getByRole("textbox", { name: "What should change?" }).fill("Name the release date");
    await tasks.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(needsYou.getByText("Draft the announcement")).toHaveCount(0);

    await expect
      .poll(() =>
        (fixture.daemon.store.snapshot(["task"]).task ?? [])
          .filter((task) => task.title === "Write the changelog")
          .map((task) => task.state),
      )
      .toEqual(["completed"]);
    await settle(page);
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("tasks.png"), fullPage: true });

    // Command-T closes the page again.
    await page.keyboard.press("Meta+t");
    await expect(tasks).toHaveCount(0);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
