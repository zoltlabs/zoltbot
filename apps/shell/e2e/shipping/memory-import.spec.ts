import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** M4: Import memory… reads an export; what it finds waits in Needs review. */
test("Import memory reads a ChatGPT export and its memories wait for review", async ({ page }) => {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/import-"));
  const file = path.join(dir, "memories.json");
  writeFileSync(file, JSON.stringify(["Prefers metric units.", "Lives in Lisbon."]));
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    // The Mac's file picker isn't available headless; the page gets the file it would return.
    await page.evaluate((picked) => {
      const memory = (window as unknown as { openbot: { memory: Record<string, unknown> } }).openbot
        .memory;
      memory.importChoose = async () => ({
        source: "chatgpt",
        path: picked,
        name: "memories.json",
        memories: 2,
        conversations: 0,
      });
    }, file);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Memory/ }).click();
    const memory = page.getByRole("main", { name: "Memory" });

    await memory.getByRole("button", { name: "Import memory…" }).click();
    await page.getByRole("menuitem", { name: "ChatGPT" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Import from ChatGPT?" });
    await expect(dialog).toContainText("memories.json has 2 saved memories and 0 conversations.");
    expect(await axeViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();

    await expect(memory.locator(".memory-import-status")).toContainText("2 memories to review");
    expect(await axeViolations(page)).toEqual([]);
    await memory.getByRole("button", { name: "Review", exact: true }).click();
    await expect(memory.getByText("Prefers metric units.")).toBeVisible();
    await expect(memory.getByText("From your ChatGPT export.").first()).toBeVisible();
  } finally {
    await shell.close();
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
