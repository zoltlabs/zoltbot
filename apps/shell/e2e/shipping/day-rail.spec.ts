import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

const DAY_MS = 86_400_000;

/**
 * The daemon runs in this process and stamps messages with `new Date()`. Shifting the clock
 * lets one test write a chat that spans several days.
 */
function shiftClock() {
  const RealDate = Date;
  let offset = 0;
  class ShiftedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
  return {
    daysAgo: (days: number) => {
      offset = -days * DAY_MS;
    },
    restore: () => {
      globalThis.Date = RealDate;
    },
  };
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Release notes" });
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
  await expect(page.locator("article.message-entry", { hasText: text })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0, {
    timeout: 15_000,
  });
}

test("a chat over several days shows a day rail that jumps to each day", async ({ page }) => {
  const clock = shiftClock();
  let fixture: Awaited<ReturnType<typeof compareFixture>> | undefined;
  let shell: Awaited<ReturnType<typeof shellSession>> | undefined;
  try {
    fixture = await compareFixture();
    shell = await shellSession(fixture.daemon);
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await page.setViewportSize({ width: 1100, height: 420 });
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    const rail = page.getByRole("navigation", { name: "Days" });

    clock.daysAgo(4);
    await send(page, "Plan the release");
    clock.daysAgo(3);
    await send(page, "Check the draft");
    // Two calendar days: no rail yet.
    await expect(rail).toHaveCount(0);

    clock.daysAgo(0);
    for (const text of ["Ship it", "Tag the build", "Post the notes", "Close the milestone"])
      await send(page, text);
    await expect(rail).toBeVisible();
    const marks = rail.getByRole("button");
    await expect(marks).toHaveCount(3);
    await expect(marks.nth(2)).toHaveAttribute("aria-current", "true");
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await marks.first().hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      (await marks.first().getAttribute("aria-label")) ?? "",
    );
    await marks.first().click();
    const first = page.locator("article.message-entry", { hasText: "Plan the release" });
    await expect(first).toBeFocused();
    await expect(first).toBeInViewport();
    await expect(marks.first()).toHaveAttribute("aria-current", "true");
    expect(shell.errors).toEqual([]);
  } finally {
    clock.restore();
    await shell?.close();
    await fixture?.close();
  }
});
