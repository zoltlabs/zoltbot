import { expect, test } from "@playwright/test";
import { parseEvent } from "@zoltbot/protocol";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** R1, R2, R3, R4, R6: the Routines page runs a routine now, pauses it, makes it one-time, adds it to Calendar and shows it on the calendar. */
test("routines run now, pause, reschedule once and show on the calendar", async ({ page }) => {
  const fixture = await compareFixture();
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 2 * 86_400_000);
  const project = {
    id: "routine-project",
    name: "Website",
    goal: "",
    instructions: "",
    constraints: "",
    roots: [],
    hierarchyDepth: 0,
    tags: [],
    requireCodeReview: false,
    skipFinalGateWhenReviewed: false,
    archived: false,
    createdAt: at,
  };
  const routine = {
    id: "routine-standup",
    name: "Morning check",
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    template: {
      title: "Morning check",
      brief: "Check the build",
      acceptance: "",
      profileId: "profile",
      node: { type: "project", id: project.id },
      inputs: { knowledge: "inherit", skills: "inherit", connections: "inherit" },
    },
    permissionCeiling: "read_only",
    notify: "actionable_only",
    paused: false,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: at,
    updatedAt: at,
  };
  // R2: a webhook routine stays a paused draft until the cloud gives it an address.
  const hook = {
    ...routine,
    id: "routine-hook",
    name: "Deploy notes",
    paused: true,
    event: {
      source: { kind: "webhook.received", resource: "webhook/deploys" },
      revision: 1,
      phase: "draft",
      proposedBy: "profile",
      location: "local",
      dailyLimit: 5,
    },
  };
  fixture.daemon.store.dispatch("seed-routine", () => ({
    result: {},
    events: [
      parseEvent({
        eventId: "seed-routine:project",
        aggregateType: "project",
        aggregateId: project.id,
        type: "project.created",
        occurredAt: at,
        payload: project,
      }),
      parseEvent({
        eventId: "seed-routine:0",
        aggregateType: "routine",
        aggregateId: routine.id,
        type: "routine.created",
        occurredAt: at,
        payload: routine,
      }),
      parseEvent({
        eventId: "seed-routine:hook",
        aggregateType: "routine",
        aggregateId: hook.id,
        type: "routine.created",
        occurredAt: at,
        payload: hook,
      }),
    ],
  }));
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: "Routines", exact: true }).click();
    const main = page.getByRole("main", { name: "Routines" });
    await expect(main.getByRole("heading", { name: "Routines", level: 1 })).toBeFocused();
    const row = main.getByRole("listitem").filter({ hasText: "Morning check" });
    await expect(row).toContainText("Daily at 9:00 AM · First");
    await expect(row).toContainText(/Next /);
    await expect(main.getByRole("listitem").filter({ hasText: "Deploy notes" })).toContainText(
      "When the deploys web address is called",
    );
    expect(await axeViolations(page)).toEqual([]);

    // R4: the Mac stays awake shortly before a routine is due, once the owner says so.
    const keepAwake = main.getByRole("button", { name: /^Keep Mac awake/ });
    await expect(keepAwake).toContainText("Never");
    await keepAwake.click();
    await page.getByRole("option", { name: "Also before routines" }).click();
    await expect(keepAwake).toContainText("Also before routines");
    await expect
      .poll(() => page.evaluate(() => window.openbot.preferences?.get().then((p) => p.keepAwake)))
      .toBe("working-or-due");

    const actions = row.getByRole("button", { name: "Actions for Morning check" });
    await actions.click();
    await page.getByRole("menuitem", { name: "Run now" }).click();
    await expect(main.getByRole("status")).toHaveText("Morning check started.");
    await actions.click();
    await page.getByRole("menuitem", { name: "Show runs" }).click();
    const runs = main.getByRole("region", { name: "Runs of Morning check" });
    await expect(runs).toContainText("Run by you");

    await actions.click();
    await page.getByRole("menuitem", { name: "Pause" }).click();
    await expect(row).toContainText("Paused");
    await actions.click();
    await page.getByRole("menuitem", { name: "Resume" }).click();
    await expect(row).toContainText(/Next /);

    await actions.click();
    await page.getByRole("menuitem", { name: "Change schedule…" }).click();
    const dialog = page.getByRole("dialog", { name: "When Morning check runs" });
    await dialog.getByRole("radio", { name: "Once" }).check();
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${later.getUTCFullYear()}-${pad(later.getUTCMonth() + 1)}-${pad(later.getUTCDate())}`;
    await dialog.getByLabel("Date").fill(day);
    await dialog.getByLabel("Time").fill("09:00");
    await expect(dialog).toContainText("Times are in UTC.");
    expect(await axeViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Save schedule" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText("Once · First");
    const saved = fixture.daemon.store.record("routine", routine.id);
    expect(saved?.schedule).toMatchObject({ cron: "@once", at: `${day}T09:00:00.000Z` });

    // R6: the coming runs go to Calendar, here without their names.
    await main.getByRole("button", { name: "Add to Calendar" }).click();
    const calendar = page.getByRole("dialog", { name: "Add runs to Calendar" });
    await calendar.getByRole("checkbox", { name: "Show routine names" }).uncheck();
    expect(await axeViolations(page)).toEqual([]);
    await calendar.getByRole("button", { name: "Add runs" }).click();
    await expect(calendar).toBeHidden();
    await expect(main.getByRole("status")).toHaveText("Added 1 run to Calendar.");

    await main.getByRole("button", { name: "Schedule", exact: true }).click();
    const runDay = new Date(`${day}T09:00:00.000Z`);
    const label = `${runDay.toLocaleDateString("en-US", { month: "long", day: "numeric" })}, 1 run`;
    // The run may fall in next month's grid.
    const cell = main.getByRole("button", { name: label });
    if (!(await cell.isVisible())) await main.getByRole("button", { name: "Next month" }).click();
    await cell.click();
    await expect(cell).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByRole("listitem").filter({ hasText: "Morning check" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
