import { expect, test } from "@playwright/test";
import { parseEvent } from "@zoltbot/protocol";
import { parseSkill, SkillsLibrary } from "../../../../packages/skills/src/index";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** M6: an agent's skill update waits in Needs review as a diff; Save writes a new revision. */
const at = "2026-11-20T00:00:00.000Z";
const before =
  "---\nname: release-checklist\ndescription: Cut a release\n---\nRun the tests.\nPush.\n";
const after =
  "---\nname: release-checklist\ndescription: Cut a release\n---\nRun the tests.\nTag the commit.\n";

test("Save applies an agent's skill update shown as a diff", async ({ page }) => {
  const fixture = await compareFixture();
  const library = new SkillsLibrary(fixture.daemon.store.database);
  const skill = library.add(parseSkill([{ path: "SKILL.md", content: before }]));
  const proposal = {
    id: "skill-proposal-1",
    state: "pending",
    name: "release-checklist",
    description: "Cut a release",
    content: after,
    basedOn: { id: skill.id, revision: 1 },
    agentId: "profile",
    threadId: "thread",
    sessionId: "session",
    createdAt: at,
    updatedAt: at,
  };
  fixture.daemon.store.dispatch("seed-skill-proposal", () => ({
    result: {},
    events: [
      parseEvent({
        eventId: "seed-skill-proposal:0",
        aggregateType: "skillProposal",
        aggregateId: proposal.id,
        type: "skillProposal.created",
        occurredAt: at,
        payload: proposal,
      }),
    ],
  }));
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Memory/ }).click();
    const memory = page.getByRole("main", { name: "Memory" });
    await memory.getByRole("button", { name: /^Needs review/ }).click();

    const row = memory.locator(`[data-proposal-id="${proposal.id}"]`);
    await expect(row.getByText("Save as skill: release-checklist")).toBeVisible();
    const changes = row.getByRole("list", { name: "Changes" });
    await expect(changes.locator(".skill-diff-removed")).toHaveText("−RemovedPush.");
    await expect(changes.locator(".skill-diff-added")).toHaveText("+AddedTag the commit.");
    expect(await axeViolations(page)).toEqual([]);

    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => fixture.daemon.store.record("skillProposal", proposal.id)?.state)
      .toBe("saved");
    expect(library.get(skill.id).current_revision).toBe(2);
    expect(library.revision(skill.id, 2).bundle.body).toBe("Run the tests.\nTag the commit.\n");
    await expect(memory.getByText("Saved release-checklist as a skill.")).toBeAttached();
    await expect(row).toHaveCount(0);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
