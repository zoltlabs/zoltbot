import { expect, test } from "@playwright/test";
import { parseEvent } from "@zoltbot/protocol";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** S6: the Usage page totals spend by chat, sorts it, filters by project and sets a budget. */
test("usage lists spend by chat and saves a project budget", async ({ page }) => {
  const fixture = await compareFixture();
  const at = new Date().toISOString();
  const snapshot = fixture.daemon.store.snapshot(["thread"]);
  const first = (snapshot.thread ?? []).find((thread) => thread.archived !== true);
  expect(first).toBeDefined();
  const project = {
    id: "usage-project",
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
  // A second chat, so the table has two rows to sort.
  const threads = [first ?? {}, { ...first, id: "usage-thread", title: "Research notes" }];
  const projectId = project.id;
  let index = 0;
  const event = (aggregateType: string, payload: { id: string }) =>
    parseEvent({
      eventId: `seed-usage:${index++}`,
      aggregateType,
      aggregateId: payload.id,
      type: `${aggregateType}.created`,
      occurredAt: at,
      payload,
    });
  const runs = threads.map((thread, at_) => ({
    thread,
    session: `usage-session-${at_}`,
    costUsd: at_ === 0 ? 1.25 : 0.4,
    tokens: at_ === 0 ? 2_000 : 30_000,
  }));
  fixture.daemon.store.dispatch("seed-usage", () => ({
    result: {},
    events: [
      event("project", project),
      event("thread", threads[1] as { id: string }),
      ...runs.flatMap((run, at_) => [
        event("session", {
          id: run.session,
          threadId: String(run.thread.id),
          provider: "claude",
          cwd: "/tmp",
          state: "closed",
          model: "sonnet",
          capabilities: {},
          startedAt: at,
        } as { id: string }),
        event("usage", {
          id: `usage-${at_}`,
          sessionId: run.session,
          ...(at_ === 0 ? { projectId } : {}),
          inputTokens: run.tokens,
          outputTokens: 0,
          costUsd: run.costUsd,
          costKnown: true,
          injectedTokens: 0,
          recordedAt: at,
        } as { id: string }),
      ]),
    ],
  }));
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: "Usage", exact: true }).click();
    const usage = page.getByRole("main", { name: "Usage" });
    await expect(usage.getByRole("heading", { name: "Usage", level: 1 })).toBeFocused();

    const table = usage.getByRole("table", { name: "Usage by agent" });
    const names = () => table.getByRole("rowheader").allTextContents();
    await expect(table.getByRole("rowheader")).toHaveCount(2);
    await expect(usage.getByRole("definition").filter({ hasText: "$1.65" })).toBeVisible();
    const [costly, wordy] = await names();
    await table.getByRole("button", { name: "Tokens" }).click();
    await expect.poll(names).toEqual([wordy, costly]);
    await usage.getByRole("button", { name: "30 days" }).click();
    await expect(usage.getByRole("button", { name: "30 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(usage.getByText("Cost by day")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    // A project shows only its own chats, and its budget can be set.
    await usage.getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("option", { name: project.name }).click();
    await expect(table.getByRole("rowheader")).toHaveCount(1);
    const budget = usage.getByRole("region", { name: `${project.name} budget` });
    await budget.getByRole("button", { name: "Set budget" }).click();
    await budget.getByRole("textbox", { name: "Budget in US dollars" }).fill("30");
    expect(await axeViolations(page)).toEqual([]);
    await budget.getByRole("button", { name: "Save" }).click();
    await expect(budget.getByText("$30.00 in total")).toBeVisible();
    await expect(budget.getByRole("button", { name: "Edit" })).toBeFocused();
    expect(
      (fixture.daemon.store.snapshot(["settings"]).settings ?? []).find(
        (row) => row.key === `budget.project.${projectId}`,
      )?.value,
    ).toEqual({ usd: 30 });
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
