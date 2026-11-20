import { expect, test } from "@playwright/test";
import { openKitGallery, SHELL_ORIGIN } from "../bridge";
import { layoutProblems, overlayProblems, triggerProblems } from "./checks";

/** Each broken page must fail the check written for it, and the clean page must pass them all. */
async function openFixture(page: import("@playwright/test").Page, name: string) {
  await openKitGallery(page);
  await page.goto(`${SHELL_ORIGIN}/index.html?design-fixture=${name}`);
  await expect(page.getByRole("heading", { name: "Design fixture" })).toBeVisible();
}

test("the clean fixture passes every check", async ({ page }) => {
  await openFixture(page, "clean");
  expect(await layoutProblems(page)).toEqual([]);
});

test("a menu running off the window fails the overlay check", async ({ page }) => {
  await openFixture(page, "clipped-menu");
  const problems = await triggerProblems(
    page,
    page.getByRole("button", { name: "Open menu" }),
    "menu",
  );
  expect(problems.join("\n")).toContain("right edge off screen");
});

test("a covered popover fails the overlay check", async ({ page }) => {
  await openFixture(page, "covered-popover");
  const problems = await overlayProblems(page, page.locator("[data-kit-overlay]"), "popover");
  expect(problems.join("\n")).toContain("covered");
});

for (const [fixture, expected] of [
  ["horizontal-overflow", "scrolls sideways"],
  ["truncated-text", "cut off"],
  ["small-target", "under 24×24"],
  ["overlapping-controls", "overlaps"],
] as const) {
  test(`${fixture} fails the layout check`, async ({ page }) => {
    await openFixture(page, fixture);
    expect((await layoutProblems(page)).join("\n")).toContain(expected);
  });
}
