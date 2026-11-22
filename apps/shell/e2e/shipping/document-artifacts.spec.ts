import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { seedMarkdownArtifact } from "../../../../tools/fakes/src/artifact-seed";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/**
 * An agent's Markdown artifact has two versions. The panel picks a version, compares it with the
 * one before word by word, and saves it into the project as a document that opens in Documents.
 */
test("compare a Markdown artifact's versions and save one as a document", async ({ page }) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "zoltbot-book-")));
  writeFileSync(join(folder, "README.md"), "# A book\n");
  const fixture = await compareFixture();
  // The artifact is written straight to the store, so the shell connects after it exists.
  const setup = await shellSession(fixture.daemon);
  const ceo = await setup.service.createProject(folder);
  await setup.close();
  await seedMarkdownArtifact(fixture.daemon.store, {
    projectId: ceo.projectId as string,
    workspace: folder,
    title: "Book outline",
    texts: [
      "# Outline\n\nPart one: the harbour.\n",
      "# Outline\n\nPart one: the harbour at night.\n\nPart two: the storm.\n",
    ],
  });
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Fixture/ }).click();
    // One card per turn that saved a version; the newest is version 2.
    await page.getByRole("button", { name: "Open Book outline" }).last().click();

    const panel = page.getByRole("complementary", { name: "Book outline" });
    await expect(panel.getByText("Document · v2")).toBeVisible();
    const version = panel.getByLabel("Version");
    await expect(version.locator("option")).toHaveCount(2);
    await expect(version.locator("option:checked")).toHaveText(/^Version 2/);

    await panel.getByRole("button", { name: "Compare with version 1" }).click();
    const changes = panel.getByRole("region", { name: "Changes from version 1 to version 2" });
    await expect(changes.getByText("Change 1 of 1")).toBeVisible();
    await expect(changes.getByText("Added “at night. Part two: the storm”")).toBeVisible();
    await expect(changes.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await page.screenshot({ path: "../../output/playwright/shell/documents-artifact-compare.png" });
    expect(await axeViolations(page)).toEqual([]);

    // An earlier version shows on its own, without anything to compare it with.
    await panel.getByRole("button", { name: "Show this version" }).click();
    await version.selectOption({
      label: (await version.locator("option").nth(1).textContent()) ?? "",
    });
    // The first version has no number next to its kind, like a new artifact.
    await expect(panel.getByText("Document", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /Compare with/ })).toHaveCount(0);
    await version.selectOption({ index: 0 });

    await panel.getByRole("button", { name: "Save as document" }).click();
    const path = panel.getByLabel("File name in the project folder");
    await expect(path).toHaveValue("notes/book-outline.md");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("Saved to notes/book-outline.md.")).toBeVisible();
    expect(readFileSync(join(folder, "notes/book-outline.md"), "utf8")).toContain("Part two");

    // Saving again under the same name explains the problem in place.
    await panel.getByRole("button", { name: "Save as document" }).click();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("A file with that name already exists.")).toBeVisible();
    await expect(path).toHaveAttribute("aria-invalid", "true");
    await panel.getByRole("button", { name: "Cancel" }).click();

    await panel.getByRole("button", { name: "Save as document" }).click();
    await path.fill("notes/outline-v2");
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "Open in Documents" }).click();
    const documents = page.getByRole("main", { name: "Documents" });
    await expect(documents.getByRole("heading", { name: "notes/outline-v2.md" })).toBeVisible();
    await expect(documents.getByRole("textbox", { name: "Document text" })).toContainText(
      "Part two: the storm.",
    );
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
