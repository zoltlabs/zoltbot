import { readFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { DaemonClient } from "../packages/ui/src/connection.js";
import { launch, navigateMain, showKnowledge, showWorkspaceTree } from "./desktop.js";

test("knowledge edits preserve revisions, keyboard drafts and both accessible themes", async () => {
  const fixture = await launch("chat");
  const { page } = fixture;
  try {
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Knowledge project");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Knowledge project", exact: true, level: 1 }),
    ).toBeVisible();
    await showKnowledge(page);
    await page.getByRole("button", { name: "New knowledge", exact: true }).click();
    const editor = page.getByRole("dialog");
    await page.getByLabel("Knowledge title", { exact: true }).fill("Meal units");
    await page.getByLabel("Knowledge body", { exact: true }).fill("Always show grams.");
    await page.getByLabel("Pin for future tasks", { exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(editor.getByText("Your draft has unsaved changes.")).toBeVisible();
    await editor.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByLabel("Knowledge body", { exact: true })).toHaveValue(
      "Always show grams.",
    );
    await editor.getByRole("button", { name: "Save knowledge", exact: true }).click();
    const row = page.getByRole("button", { name: /Meal units.*v1.*Pinned/ });
    await expect(row).toBeVisible();
    await row.click();
    await page.getByLabel("Knowledge body", { exact: true }).fill("Always show grams and ounces.");
    await editor.getByRole("button", { name: "Save knowledge", exact: true }).click();
    await page.getByRole("button", { name: /Meal units.*v2.*Pinned/ }).click();
    await editor.getByText("History", { exact: true }).click();
    await expect(editor.getByRole("heading", { name: "v1 · Meal units" })).toBeVisible();
    await expect(editor.getByText("Always show grams.", { exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/knowledge-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await showKnowledge(page);
    await page.getByRole("button", { name: /Meal units.*v2.*Pinned/ }).click();
    await page.screenshot({ path: "output/playwright/knowledge-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 760, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("knowledge CAS conflicts keep the draft and expose the current revision in both themes", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  const wire = new DaemonClient(async () =>
    JSON.parse(readFileSync(path.join(fixture.dataDir, "daemon.json"), "utf8")),
  );
  try {
    await wire.start();
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Conflict project");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Conflict project", level: 1, exact: true }),
    ).toBeVisible();
    const snapshot = (await wire.call("snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    const project = snapshot.entities.project?.find((row) => row.name === "Conflict project");
    const at = new Date().toISOString();
    let current = (await wire.call(
      "knowledge.upsert",
      {
        value: {
          id: "conflict-entry",
          scope: { type: "project", id: project?.id },
          kind: "decision",
          title: "Conflict decision",
          body: "Original approved body.",
          tags: [],
          sources: [],
          status: "active",
          revision: 1,
          createdAt: at,
          updatedAt: at,
          owner: { kind: "human", id: "local-owner" },
          verification: "human",
          writer: { kind: "human", id: "local-owner" },
        },
        expectedRevision: 0,
      },
      crypto.randomUUID(),
    )) as Record<string, unknown>;
    for (const theme of ["dark", "light"]) {
      if (theme === "light") {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("radio", { name: "Light", exact: true }).check();
        await showWorkspaceTree(page);
        await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
      }
      await showKnowledge(page);
      await page.getByRole("button", { name: /Conflict decision.*Local/ }).click();
      const editor = page.getByRole("dialog");
      await page
        .getByLabel("Knowledge body", { exact: true })
        .fill(`My ${theme} draft stays here.`);
      current = (await wire.call(
        "knowledge.upsert",
        {
          value: { ...current, body: `Concurrent ${theme} edit.` },
          expectedRevision: current.revision,
        },
        crypto.randomUUID(),
      )) as Record<string, unknown>;
      await editor.getByRole("button", { name: "Save knowledge", exact: true }).click();
      await expect(
        editor.getByText(
          "This entry changed. Your draft is kept. Compare with the current version before saving.",
        ),
      ).toBeVisible();
      await expect(page.getByLabel("Knowledge body", { exact: true })).toHaveValue(
        `My ${theme} draft stays here.`,
      );
      await expect(editor.getByRole("region", { name: "Current version" })).toContainText(
        `Concurrent ${theme} edit.`,
      );
      await page.screenshot({
        path: `output/playwright/knowledge-conflict-${theme}.png`,
        fullPage: true,
      });
      expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
      await editor
        .getByRole("button", { name: "Keep my draft for next version", exact: true })
        .click();
      await editor.getByRole("button", { name: "Save knowledge", exact: true }).click();
      await expect(editor).not.toBeVisible();
      current = (await wire.call("knowledge.get", { id: "conflict-entry" })) as Record<
        string,
        unknown
      >;
      expect(current.body).toBe(`My ${theme} draft stays here.`);
    }
  } finally {
    wire.stop();
    await fixture.cleanup();
  }
});

test("task context keeps its original knowledge after editing and request changes", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  const wire = new DaemonClient(async () =>
    JSON.parse(readFileSync(path.join(fixture.dataDir, "daemon.json"), "utf8")),
  );
  try {
    await wire.start();
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Frozen knowledge");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Frozen knowledge", level: 1, exact: true }),
    ).toBeVisible();
    await showKnowledge(page);
    await page.getByRole("button", { name: "New knowledge", exact: true }).click();
    await page.getByLabel("Knowledge title", { exact: true }).fill("Display units");
    await page.getByLabel("Knowledge body", { exact: true }).fill("Always show grams.");
    await page.getByLabel("Pin for future tasks", { exact: true }).check();
    await page.getByRole("button", { name: "Save knowledge", exact: true }).click();
    await expect(page.getByRole("button", { name: /Display units.*v1/ })).toBeVisible();
    await navigateMain(page, "Tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Check units");
    await page.getByLabel("Goal", { exact: true }).fill("Check display units for meals.");
    await page
      .locator("summary")
      .filter({ hasText: /Session inputs.*Preview/ })
      .click();
    await expect(
      page.getByText(
        "Provisional: connection and skill overhead may reduce the budget at dispatch.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    const card = page.getByRole("article", { name: "Check units" });
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    const snapshot = (await wire.call("snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    const task = snapshot.entities.task?.find((row) => row.title === "Check units");
    const frozen = await wire.call("contextPack.get", { taskId: task?.id, revision: 1 });
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await showKnowledge(page);
    await page.getByRole("button", { name: /Display units.*v1/ }).click();
    await page.getByLabel("Knowledge body", { exact: true }).fill("Always show ounces.");
    await page.getByRole("button", { name: "Save knowledge", exact: true }).click();
    await navigateMain(page, "Tasks");
    await card
      .locator("summary")
      .filter({ hasText: /Session inputs/ })
      .click();
    await expect(
      card.getByText("Changed since start. New sessions use the latest version."),
    ).toBeVisible();
    await card
      .locator("summary")
      .filter({ hasText: /knowledge-.*v1/ })
      .click();
    await expect(card.locator("pre")).toContainText("Always show grams.");
    await expect(card.locator("pre")).not.toContainText("Always show ounces.");
    await page.screenshot({ path: "output/playwright/knowledge-frozen-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await card.getByRole("button", { name: "Request changes", exact: true }).click();
    await card.getByLabel("What should change?", { exact: true }).fill("Check rounding too.");
    await card.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(card.getByText(/Revision 2/)).toBeVisible();
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    expect(await wire.call("contextPack.get", { taskId: task?.id, revision: 2 })).toEqual(frozen);
    const after = (await wire.call("snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    expect(
      new Set(
        after.entities.session
          ?.filter((row) => row.threadId === task?.threadId)
          .map((row) => row.nativeId),
      ).size,
    ).toBe(1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await navigateMain(page, "Tasks");
    await card
      .locator("summary")
      .filter({ hasText: /Session inputs/ })
      .click();
    await page.screenshot({ path: "output/playwright/knowledge-frozen-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  } finally {
    wire.stop();
    await fixture.cleanup();
  }
});
