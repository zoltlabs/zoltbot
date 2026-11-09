import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, navigateMain, showWorkspaceTree } from "./desktop.js";

test("browser selection, canonical image gallery, revision grouping and Settings in light and dark", async () => {
  const fixture = await launch("browser");
  const { page } = fixture;
  try {
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Browser fixture");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await navigateMain(page, "Tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Verify local form");
    await page.getByLabel("Goal", { exact: true }).fill("Check the harmless local form.");
    await page.getByLabel("Check the result in a local browser", { exact: true }).check();
    await page
      .getByLabel("Application URL (optional)", { exact: true })
      .fill("http://127.0.0.1:3000");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    const card = page.getByRole("article", { name: "Verify local form", exact: true });
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible({ timeout: 15000 });
    const gallery = card.getByRole("region", { name: /^Browser evidence for / });
    await gallery.getByRole("button", { name: "Refresh browser", exact: true }).click();
    const image = gallery.getByRole("img", {
      name: "Captured browser evidence, revision 1",
      exact: true,
    });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBe(1280);
    await gallery
      .getByRole("button", { name: "Open evidence from revision 1", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(
      gallery.getByRole("button", { name: "Open evidence from revision 1", exact: true }),
    ).toBeFocused();
    await gallery.getByRole("button", { name: "Reopen visibly", exact: true }).click();
    await expect(gallery.getByText(/Transient cookies/)).toBeVisible();
    await gallery.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.screenshot({ path: "output/playwright/browser-evidence-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await card.getByRole("button", { name: "Request changes", exact: true }).click();
    await card
      .getByLabel("What should change?", { exact: true })
      .fill("Inspect the same local fixture again.");
    await card.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(card.getByText(/Revision 2/).first()).toBeVisible({ timeout: 15000 });
    await expect(card.getByText("Needs review", { exact: true })).toBeVisible();
    await gallery.getByRole("button", { name: "Refresh browser", exact: true }).click();
    await expect(gallery.getByRole("heading", { name: /Revision 2/ })).toBeVisible();
    await expect(gallery.getByRole("heading", { name: /Revision 1/ })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Coding agents", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await navigateMain(page, "Tasks");
    await gallery.getByRole("button", { name: "Refresh browser", exact: true }).click();
    await expect(gallery.getByRole("img").first()).toBeVisible();
    await page.screenshot({ path: "output/playwright/browser-evidence-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("read-only browser refusal keeps the task draft and does not create a task", async () => {
  const fixture = await launch("chat");
  const { page } = fixture;
  try {
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Read-only fixture");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await navigateMain(page, "Tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Keep my draft");
    await page.getByLabel("Goal", { exact: true }).fill("Local verification");
    await page.getByLabel("Check the result in a local browser", { exact: true }).check();
    await expect(page.getByText(/This profile cannot execute shell commands/)).toBeVisible();
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keep my draft");
    await expect(
      page.getByText("Choose a workspace-write profile to use browser verification.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("article", { name: "Keep my draft", exact: true })).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});
