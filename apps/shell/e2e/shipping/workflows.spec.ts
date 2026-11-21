import { expect, test } from "@playwright/test";
import { parseEvent } from "@zoltbot/protocol";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** R7: the Workflows view shows a workflow as a graph, runs it, waits for approval and continues. */
test("workflows run from the canvas and wait for approval", async ({ page }) => {
  const fixture = await compareFixture();
  const at = new Date().toISOString();
  const project = {
    id: "workflow-project",
    name: "Newsroom",
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
  const workflow = {
    workflowId: "digest",
    version: 1,
    name: "Morning digest",
    description: "",
    scope: { type: "project", id: project.id },
    inputs: {},
    briefTemplate: "Write the digest.",
    acceptance: "",
    expectedDeliverable: { kind: "report", title: "Digest" },
    checks: [],
    permissionProfile: "read_only",
    executorAgent: "profile",
    workspaceMode: "shared",
    budget: {},
    retry: { maxAttempts: 1, backoffSeconds: [], retryOn: [] },
    review: "required",
    notify: "on_change",
    trigger: [{ kind: "manual" }],
    overlap: "skip",
    previousResult: "none",
    stages: [],
    loops: [],
    graph: {
      nodes: [
        { id: "start", kind: "trigger", name: "By hand", trigger: { type: "manual" } },
        { id: "ok", kind: "wait", name: "Check with me", until: { type: "approval" } },
        {
          id: "write",
          kind: "agent",
          name: "Write the digest",
          profileId: "profile",
          brief: "Write a short digest of today's news.",
          gate: "human",
        },
      ],
      edges: [
        { from: "start", to: "ok", carry: "none" },
        { from: "ok", to: "write", carry: "none" },
      ],
    },
  };
  fixture.daemon.store.dispatch("seed-workflow", () => ({
    result: {},
    events: [
      parseEvent({
        eventId: "seed-workflow:project",
        aggregateType: "project",
        aggregateId: project.id,
        type: "project.created",
        occurredAt: at,
        payload: project,
      }),
      parseEvent({
        eventId: "seed-workflow:0",
        aggregateType: "workflow",
        aggregateId: "digest:1",
        type: "workflow.created",
        occurredAt: at,
        payload: workflow,
      }),
    ],
  }));
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: "Routines", exact: true }).click();
    const main = page.getByRole("main", { name: "Routines" });
    await main.getByRole("button", { name: "Workflows" }).click();
    const open = main.getByRole("button", { name: /Morning digest/ });
    await expect(open).toContainText("Run by you · 2 steps");
    await expect(open).toContainText("No runs yet");
    await open.click();
    const back = main.getByRole("button", { name: "All workflows" });
    await expect(back).toBeFocused();
    await expect(main.getByRole("heading", { name: "Morning digest", level: 2 })).toBeVisible();
    const canvas = main.getByRole("region", { name: "Steps of Morning digest" });
    const start = canvas.getByRole("button", { name: /^Step 1 of 3: Start, By hand/ });
    await expect(start).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    // Arrow keys follow the edges.
    await start.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      canvas.getByRole("button", { name: /^Step 2 of 3: Wait, Check with me/ }),
    ).toBeFocused();

    await main.getByRole("button", { name: "Run now" }).click();
    const wait = canvas.getByRole("button", { name: /Check with me, Needs you$/ });
    await expect(wait).toBeVisible();
    await wait.click();
    const panel = main.getByRole("region", { name: "Step Check with me" });
    await expect(panel).toContainText("Waits for your approval");
    expect(await axeViolations(page)).toEqual([]);
    await expect(panel).toContainText("Continue to the next steps, or stop this run?");
    await panel.getByRole("button", { name: "Continue" }).click();
    // The buttons go away once answered; focus returns to the step.
    await expect(canvas.getByRole("button", { name: /Check with me, Done$/ })).toBeFocused();
    await expect(
      canvas.getByRole("button", { name: /Write the digest, (Running|Needs you)$/ }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: /Check with me, Done$/ })).toBeVisible();

    // Editing: add a step after the last one, rename it, then remove it. Each save is a new version.
    await canvas.getByRole("button", { name: /Write the digest/ }).click();
    const writePanel = main.getByRole("region", { name: "Step Write the digest" });
    await writePanel.getByRole("button", { name: "Add step after" }).click();
    const addForm = main.getByRole("form", { name: "Add a step after Write the digest" });
    await expect(addForm.getByRole("button", { name: /^Step type/ })).toBeFocused();
    await addForm.getByRole("button", { name: /^Step type/ }).click();
    await page.getByRole("option", { name: "Wait" }).click();
    await addForm.getByRole("textbox", { name: "Name" }).fill("Final check");
    expect(await axeViolations(page)).toEqual([]);
    await addForm.getByRole("button", { name: "Save" }).click();
    const added = canvas.getByRole("button", { name: /^Step 4 of 4: Wait, Final check/ });
    await expect(added).toBeFocused();

    const addedPanel = main.getByRole("region", { name: "Step Final check" });
    await addedPanel.getByRole("button", { name: "Edit step" }).click();
    const editForm = main.getByRole("form", { name: "Edit Final check" });
    await editForm.getByRole("textbox", { name: "Name" }).fill("");
    await editForm.getByRole("button", { name: "Save" }).click();
    const nameField = editForm.getByRole("textbox", { name: "Name" });
    await expect(nameField).toBeFocused();
    await expect(nameField).toHaveAccessibleDescription("Give the step a name.");
    await editForm.getByRole("textbox", { name: "Name" }).fill("Last look");
    await editForm.getByRole("button", { name: "Save" }).click();
    await expect(
      canvas.getByRole("button", { name: /^Step 4 of 4: Wait, Last look/ }),
    ).toBeFocused();

    await main
      .getByRole("region", { name: "Step Last look" })
      .getByRole("button", { name: "Remove step" })
      .click();
    await main.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(
      canvas.getByRole("button", { name: /^Step 3 of 3: Agent, Write the digest/ }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: /Last look/ })).toHaveCount(0);

    // Pause, then back to the list, where focus returns to the workflow's row.
    await main.getByRole("button", { name: "Pause" }).click();
    await expect(main.getByRole("button", { name: "Resume" })).toBeVisible();
    await back.click();
    await expect(open).toBeFocused();
    await expect(open).toContainText("Paused");
  } finally {
    await shell.close();
    await fixture.close();
  }
});
