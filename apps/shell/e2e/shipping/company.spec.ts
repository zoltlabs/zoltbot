import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/**
 * Ported from tests/shipping/company.spec.ts. The shell's Organization panel reviews plans,
 * lists people and initiatives, and refreshes the project brief; editing responsibilities,
 * initiatives and the organization from the UI are not in the shell yet (see NOT-PORTED.md).
 */
test("organization plans, initiatives, brief and stale approvals stay usable", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const ceo = await shell.service.createProject(mkdtempSync(join(tmpdir(), "example-company-")));
    const projectId = String(ceo.projectId);
    const at = new Date().toISOString();
    await shell.rpc.call(
      "company.propose",
      {
        id: "org",
        projectId,
        title: "Launch team",
        explanation: "Coordinate the launch",
        changes: [
          {
            kind: "team",
            id: "eng",
            name: "Engineering",
            parent: { type: "project", id: projectId },
            why: "Own implementation",
          },
          {
            kind: "chat",
            id: "lead",
            title: "Engineering lead",
            parent: { type: "subproject", id: "eng" },
            profileId: "profile",
            manager: true,
            why: "Coordinate execution",
          },
        ],
      },
      "org",
    );

    await shell.open(page);
    await page.getByRole("button", { name: /CEO/ }).first().click();
    await page.getByRole("button", { name: "Organization", exact: true }).first().click();
    const panel = page.getByRole("complementary", { name: "Organization" });
    await expect(panel.getByRole("heading", { name: "Plans to review" })).toBeVisible();
    const approve = panel.getByRole("button", { name: "Approve Launch team", exact: true });
    await approve.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByText("Approved Launch team.")).toBeVisible();
    const lead = panel.getByRole("button", { name: /Engineering lead\s*Engineering manager/ });
    await expect(lead).toBeVisible();
    // People lists the new manager too, with Edit and Archive.
    await expect(panel.getByRole("button", { name: "Edit Engineering lead" })).toBeVisible();

    await shell.rpc.call(
      "company.propose",
      {
        id: "initiative",
        projectId,
        title: "Onboarding launch",
        explanation: "Start the onboarding work",
        changes: [
          {
            kind: "initiative",
            why: "Customers need to sign up",
            value: {
              id: "onboarding",
              projectId,
              teamId: "eng",
              title: "Onboarding launch",
              outcome: "New customers can complete signup",
              acceptance: "Signup and error flows verified",
              managerThreadId: "lead",
              priority: "high",
              state: "active",
              constraints: "",
              knowledgeIds: [],
              version: 1,
              createdAt: at,
              updatedAt: at,
            },
          },
        ],
      },
      "initiative",
    );
    await panel.getByRole("button", { name: "Approve Onboarding launch", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Initiatives" })).toBeVisible();
    await expect(panel.getByText("Onboarding launch", { exact: true })).toBeVisible();
    await expect(panel.getByText("Active · high priority", { exact: false })).toBeVisible();

    await panel.getByRole("button", { name: "Refresh brief", exact: true }).click();
    await expect(panel.getByText("Brief updated.")).toBeVisible();
    await expect(panel.getByText("No brief yet.")).toHaveCount(0);

    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("organization.png"), fullPage: true });

    // A plan made before the company changed is refused, and the person can decline it.
    await shell.rpc.call(
      "company.propose",
      {
        id: "stale",
        projectId,
        title: "Stale rename",
        explanation: "Old state",
        changes: [{ kind: "renameTeam", id: "eng", name: "Old name", why: "Test stale approval" }],
      },
      "stale",
    );
    await shell.rpc.call(
      "project.update",
      { id: projectId, changes: { goal: "Retention first" } },
      "priority-change",
    );
    await panel.getByRole("button", { name: "Approve Stale rename", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Ask for a new plan");
    await panel.getByRole("button", { name: "Decline Stale rename", exact: true }).click();
    await expect(panel.getByText("Declined Stale rename.")).toBeVisible();
    expect(
      (fixture.daemon.store.snapshot(["companyPlan"]).companyPlan ?? []).map(
        (plan) => `${plan.id}:${plan.state}`,
      ),
    ).toEqual(expect.arrayContaining(["org:applied", "initiative:applied", "stale:declined"]));
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
