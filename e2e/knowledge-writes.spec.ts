import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { DaemonClient } from "../packages/ui/src/connection.js";
import { launch, navigateMain, showKnowledge, showWorkspaceTree } from "./desktop.js";

type Snapshot = { entities: Record<string, Record<string, unknown>[]> };

test("user preference reaches a task and a chat; an agent lesson is reviewed, reverted and gone", async () => {
  const fixture = await launch("knowledge"),
    { page } = fixture;
  const wire = new DaemonClient(async () =>
    JSON.parse(readFileSync(path.join(fixture.dataDir, "daemon.json"), "utf8")),
  );
  const snapshot = async () => (await wire.call("snapshot.get", {})) as Snapshot;
  /** The fixture daemon writes as the task's agent through the real write policy. */
  const agentWrite = async (threadId: string, args: Record<string, unknown>) => {
    const result = path.join(fixture.dataDir, "knowledge-agent-write.result.json");
    rmSync(result, { force: true });
    writeFileSync(
      path.join(fixture.dataDir, "knowledge-agent-write.json"),
      JSON.stringify({ threadId, arguments: args }),
    );
    await expect.poll(() => existsSync(result)).toBe(true);
    return JSON.parse(readFileSync(result, "utf8")) as Record<string, unknown>;
  };
  const newTask = async (title: string) => {
    await navigateMain(page, "Tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Goal", { exact: true }).fill("Write the release note for today.");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    const card = page.getByRole("article", { name: title });
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    const task = (await snapshot()).entities.task?.find((row) => row.title === title);
    if (!task) throw new Error("task_missing");
    return { card, task };
  };
  const packText = async (taskId: unknown) =>
    JSON.stringify(await wire.call("contextPack.get", { taskId, revision: 1 }));
  try {
    await wire.start();
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Alpha");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Alpha", level: 1, exact: true })).toBeVisible();

    // A person writes a preference in the user scope.
    await showKnowledge(page);
    await page.getByRole("radio", { name: "You (all workspaces)", exact: true }).check();
    await page.getByRole("button", { name: "New knowledge", exact: true }).click();
    await page.getByLabel("Knowledge title", { exact: true }).fill("Date format");
    await page.getByLabel("Knowledge body", { exact: true }).fill("Write dates as YYYY-MM-DD.");
    await page.getByLabel("Pin for future tasks", { exact: true }).check();
    await page.getByRole("button", { name: "Save knowledge", exact: true }).click();
    await expect(page.getByRole("button", { name: /Date format.*v1/ })).toBeVisible();

    // It reaches a task in Alpha, and the inspector shows it.
    const first = await newTask("Release note");
    await first.card
      .locator("summary")
      .filter({ hasText: /Session inputs/ })
      .click();
    await first.card
      .locator("summary")
      .filter({ hasText: /knowledge-.*v1/ })
      .first()
      .click();
    await expect(first.card.locator("pre").first()).toContainText("YYYY-MM-DD");
    await expect(first.card.getByRole("region", { name: "Knowledge written" })).toContainText(
      "No knowledge written by this run.",
    );

    // The task's agent writes a project lesson; it is applied unverified.
    const written = await agentWrite(String(first.task.threadId), {
      op: "create",
      scope: "project",
      kind: "lesson",
      title: "Changelog first",
      body: "Release notes are generated from CHANGELOG.md, so update it first.",
      evidence: [{ kind: "task", ref: first.task.id }],
      reason: "The release script failed without it",
    });
    expect(written).toMatchObject({ result: "applied" });
    await page.reload();
    await navigateMain(page, "Tasks");
    await first.card
      .locator("summary")
      .filter({ hasText: /Session inputs/ })
      .click();
    await expect(first.card.getByRole("region", { name: "Knowledge written" })).toContainText(
      "applied",
    );

    // It is listed in the Inbox digest, and the person reverts it.
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    const digest = page.getByRole("region", { name: "Agent knowledge writes today" });
    await expect(digest).toContainText("Changelog first");
    await expect(digest).toContainText("Unverified");
    await page.screenshot({ path: "output/playwright/knowledge-digest.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await digest.getByRole("button", { name: "Revert…", exact: true }).click();
    await digest.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(digest).toHaveCount(0);
    expect(
      (await snapshot()).entities.knowledge?.find((row) => row.title === "Changelog first"),
    ).toMatchObject({ status: "archived", writer: { kind: "human" } });

    // The next task's pack no longer has the lesson but keeps the preference.
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    const second = await newTask("Second release note");
    const pack = await packText(second.task.id);
    expect(pack).toContain("YYYY-MM-DD");
    expect(pack).not.toContain("CHANGELOG.md");

    // The same preference reaches a chat in another workspace.
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Beta");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Beta", level: 1, exact: true })).toBeVisible();
    await page
      .getByLabel("Start a chat in this workspace", { exact: true })
      .fill("Plan the release");
    await page.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan the release", exact: true }),
    ).toBeVisible();
    const chat = (await snapshot()).entities.thread?.find(
      (row) => row.title === "Plan the release",
    );
    await expect
      .poll(async () =>
        JSON.stringify(
          (await snapshot()).entities.contextPack?.filter((row) => row.threadId === chat?.id),
        ),
      )
      .toContain("YYYY-MM-DD");
  } finally {
    wire.stop();
    await fixture.cleanup();
  }
});
