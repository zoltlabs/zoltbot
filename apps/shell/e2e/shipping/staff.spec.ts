import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { requestStaffChange } from "../../../../packages/daemon/src/staff-tools";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

type Fixture = Awaited<ReturnType<typeof compareFixture>>;
type Context = Parameters<typeof requestStaffChange>[0];

const threads = (fixture: Fixture) =>
  (fixture.daemon.store.snapshot(["thread"]).thread ?? []) as Record<string, unknown>[];
const threadId = (fixture: Fixture, title: string) =>
  String(threads(fixture).find((row) => row.title === title && !row.archived)?.id ?? "");

/**
 * A team manager asks to add one employee and change another. The owner approves the add with a
 * standing allowance from Needs you, declines the change, then edits and archives people from the
 * Organization panel. The requests are synthetic: the manager's tool call runs without a model.
 */
test("staff approvals and the organization's Edit and Archive", async ({ page }) => {
  const fixture = await compareFixture();
  let shell = await shellSession(fixture.daemon);
  try {
    const ceo = await shell.service.createProject(mkdtempSync(join(tmpdir(), "example-staff-")));
    const projectId = String(ceo.projectId);
    await shell.rpc.call(
      "company.propose",
      {
        id: "org",
        projectId,
        title: "Design team",
        explanation: "Own the visuals",
        changes: [
          {
            kind: "team",
            id: "design",
            name: "Design",
            parent: { type: "project", id: projectId },
            why: "Own the visuals",
          },
          {
            kind: "chat",
            id: "robin",
            title: "Robin",
            parent: { type: "subproject", id: "design" },
            profileId: "profile",
            manager: true,
            why: "Lead design",
          },
          {
            kind: "chat",
            id: "ivy",
            title: "Ivy",
            parent: { type: "subproject", id: "design" },
            profileId: "profile",
            manager: false,
            why: "Draw icons",
          },
        ],
      },
      "org",
    );
    await shell.service.decidePlan({ projectId, planId: "org", version: 1, approve: true });
    await shell.close();

    // Robin asks while no shell is connected; the next shell reads the requests from the store.
    const robin = threadId(fixture, "Robin");
    const ivy = threadId(fixture, "Ivy");
    const context = {
      store: fixture.daemon.store,
      privacy: { prepareData: async () => () => undefined },
      publish() {},
    } as unknown as Context;
    const actor = { agentId: "profile", threadId: robin, sessionId: "e2e" };
    await requestStaffChange(
      context,
      actor,
      { kind: "add", name: "Nova", role: "Draws illustrations", model: "opus" },
      "add-nova",
    );
    await requestStaffChange(
      context,
      actor,
      { kind: "change", threadId: ivy, instructions: "Use the brand palette." },
      "change-ivy",
    );

    shell = await shellSession(fixture.daemon);
    await shell.open(page);
    await expect(page.getByRole("button", { name: /Robin/ }).first()).toBeVisible();
    // The sidebar's Tasks row counts both approvals as Needs you.
    await expect(page.getByRole("button", { name: /^Tasks\s*2 need you$/ })).toBeVisible();
    await page.keyboard.press("Meta+t");
    const tasks = page.getByRole("main", { name: "Tasks" });
    const needsYou = tasks.getByRole("region", { name: /^Needs you/ });
    await expect(needsYou).toContainText("Needs you · 2");
    const add = needsYou.getByRole("region", { name: "Add Nova to Design" });
    await expect(add.getByText("Asked by Robin")).toBeVisible();
    await expect(add.getByText("opus")).toBeVisible();
    const change = needsYou.getByRole("region", { name: "Change Ivy" });
    await expect(change.locator("ins")).toContainText("Use the brand palette.");
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("staff-needs-you.png"), fullPage: true });

    await add.getByRole("checkbox", { name: /Let Robin add up to 2 more/ }).check();
    await add.getByRole("button", { name: "Add Nova", exact: true }).click();
    await expect.poll(() => threadId(fixture, "Nova")).not.toBe("");
    await change.getByRole("button", { name: "Decline: Change Ivy" }).click();
    await expect(needsYou).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Tasks$/ })).toBeVisible();
    await expect
      .poll(() =>
        (fixture.daemon.store.snapshot(["settings"]).settings ?? []).some(
          (row) => row.key === `staff.allowance.${robin}`,
        ),
      )
      .toBe(true);

    // The approved card stays in Robin's chat where it was asked.
    await page.keyboard.press("Meta+t");
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /Robin/ }).first().click();
    const inline = page.getByRole("region", { name: "Add Nova to Design" });
    await expect(inline.getByText("Approved", { exact: true })).toBeVisible();

    // The owner edits Ivy and archives Nova from the Organization panel, opened from the CEO's chat.
    await sidebar.getByRole("button", { name: /CEO/ }).first().click();
    await page.getByRole("button", { name: "Organization", exact: true }).first().click();
    const panel = page.getByRole("complementary", { name: "Organization" });
    const people = panel.getByRole("region", { name: "People" });
    await expect(people.getByText("May add 2 more")).toBeVisible();
    await people.getByRole("button", { name: "Edit Ivy" }).click();
    const edit = people.getByRole("form", { name: "Edit Ivy" });
    await edit.getByRole("textbox", { name: "Instructions" }).fill("Keep icons at 24 pixels.");
    expect(await axeViolations(page)).toEqual([]);
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toHaveCount(0);
    await expect
      .poll(() =>
        (fixture.daemon.store.snapshot(["audit"]).audit ?? []).some(
          (row) => row.action === "staff.change",
        ),
      )
      .toBe(true);

    await people.getByRole("button", { name: "Archive Nova", exact: true }).click();
    const archive = people.getByRole("form", { name: "Archive Nova" });
    await archive.getByRole("button", { name: /^Queued tasks go to:/ }).click();
    await page.getByRole("option", { name: "Ivy" }).click();
    expect(await axeViolations(page)).toEqual([]);
    await archive.getByRole("button", { name: "Archive Nova", exact: true }).click();
    await expect(people.getByText("Nova", { exact: true })).toHaveCount(0);
    await expect.poll(() => threadId(fixture, "Nova")).toBe("");
    await page.screenshot({ path: test.info().outputPath("staff-panel.png"), fullPage: true });
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
