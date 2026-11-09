import { readdirSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";
import { rpc } from "./rpc.js";

test("requires source consent, previews metadata, and imports only explicitly selected items without changing source folders", async () => {
  const fixture = await launch("doctor"),
    { page } = fixture;
  const changes: string[] = [];
  const watcher = watch(
    path.join(fixture.dataDir, "source-home"),
    { recursive: true },
    (_event, name) => changes.push(String(name)),
  );
  try {
    await page.getByRole("button", { name: "Set up coding agents", exact: true }).click();
    await page.getByRole("button", { name: "Get started", exact: true }).click();
    await page.getByRole("button", { name: /^Connect \d+ agents?$/ }).click();
    await page
      .getByRole("button", { name: "Choose sources and folders yourself", exact: true })
      .click();
    const sources = page.getByRole("group", { name: "Metadata sources", exact: true });
    for (const choice of await sources.getByRole("checkbox").all())
      await expect(choice).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Scan code folders I choose", exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Preview metadata", exact: true }),
    ).toBeDisabled();
    await sources.getByRole("checkbox", { name: "Claude Code", exact: true }).check();
    await expect(
      page.getByRole("button", { name: "Preview metadata", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "Read metadata from these selected sources and folders",
        exact: true,
      })
      .check();
    await page.screenshot({ path: "output/playwright/import-sources-light.png", fullPage: true });
    await page.getByRole("button", { name: "Preview metadata", exact: true }).click();
    const preview = page.getByRole("region", { name: "Metadata preview", exact: true });
    await expect(
      preview.getByRole("heading", { name: "Review before importing", exact: true }),
    ).toBeFocused();
    await expect(preview.getByText("Projects: 1", { exact: true })).toBeVisible();
    await expect(preview.getByText("Session links: 1", { exact: true })).toBeVisible();
    await expect(preview.getByText("MCP servers: 1", { exact: true })).toBeVisible();
    for (const choice of await preview.getByRole("checkbox").all())
      await expect(choice).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Import selected metadata", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "Read metadata from these selected sources and folders",
        exact: true,
      })
      .uncheck();
    await expect(preview).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Import selected metadata", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("checkbox", {
        name: "Read metadata from these selected sources and folders",
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "Preview metadata", exact: true }).click();
    await expect(preview).toBeVisible();
    for (const choice of await preview.getByRole("checkbox").all())
      await expect(choice).not.toBeChecked();
    await preview.getByRole("checkbox", { name: "Keep shared from claude", exact: true }).check();
    await preview
      .getByRole("row")
      .filter({ hasText: "Native session link" })
      .getByRole("checkbox")
      .check();
    if ((await page.locator("html").getAttribute("data-theme")) !== "light")
      await page.getByRole("button", { name: "Use light theme", exact: true }).click();
    await page.screenshot({ path: "output/playwright/import-preview-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "output/playwright/import-preview-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Import selected metadata", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved 2 selected metadata items");
    await expect(
      page.getByRole("button", { name: "Back to coding tools", exact: true }),
    ).toBeFocused();
    const state = (await rpc(page, "snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    expect(state.entities.nativeSession).toHaveLength(1);
    expect(state.entities.project ?? []).toHaveLength(0);
    const registry = state.entities.settings?.find((row) => row.key === "mcp.registry")?.value;
    expect(registry).toMatchObject([
      { name: "shared", state: "needs_confirmation", enabledAgentIds: [] },
    ]);
    const files = readdirSync(path.join(fixture.dataDir, "imports"));
    expect(files).toHaveLength(1);
    const receipt = JSON.parse(
      readFileSync(path.join(fixture.dataDir, "imports", String(files[0])), "utf8"),
    );
    expect(receipt.items).toHaveLength(2);
    expect(receipt.items.map((item: { kind: string }) => item.kind).sort()).toEqual([
      "mcp",
      "session",
    ]);
    expect(JSON.stringify(state)).not.toContain("synthetic-private-");
    expect(JSON.stringify(receipt)).not.toContain("synthetic-private-");
    await page
      .getByRole("checkbox", {
        name: "Read metadata from these selected sources and folders",
        exact: true,
      })
      .uncheck();
    await expect(preview).toHaveCount(0);
    await page.getByRole("button", { name: "Back to coding tools", exact: true }).click();
    await expect(page.getByText("2 metadata items saved", { exact: true })).toBeVisible();
    expect(changes).toEqual([]);
  } finally {
    watcher.close();
    await fixture.cleanup();
  }
});

test("keeps chosen code folders independent of provider source consent", async () => {
  const fixture = await launch("doctor"),
    { page } = fixture;
  const changes: string[] = [];
  const watcher = watch(
    path.join(fixture.dataDir, "source-home"),
    { recursive: true },
    (_event, name) => changes.push(String(name)),
  );
  try {
    await page.getByRole("button", { name: "Set up coding agents", exact: true }).click();
    await page.getByRole("button", { name: "Get started", exact: true }).click();
    await page.getByRole("button", { name: /^Connect \d+ agents?$/ }).click();
    await page
      .getByRole("button", { name: "Choose sources and folders yourself", exact: true })
      .click();
    await page.getByRole("checkbox", { name: "Scan code folders I choose", exact: true }).check();
    await page
      .getByRole("textbox", { name: "Code folder paths", exact: true })
      .fill(path.join(fixture.dataDir, "source-home/code"));
    await page
      .getByRole("checkbox", {
        name: "Read metadata from these selected sources and folders",
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "Preview metadata", exact: true }).click();
    const preview = page.getByRole("region", { name: "Metadata preview", exact: true });
    await expect(preview.getByText("Projects: 1", { exact: true })).toBeVisible();
    await expect(preview.getByText("Session links: 0", { exact: true })).toBeVisible();
    await expect(preview.getByText("MCP servers: 0", { exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await preview.getByRole("checkbox", { name: "Keep project from git", exact: true }).check();
    await page.getByRole("button", { name: "Import selected metadata", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved 1 selected metadata item");
    const state = (await rpc(page, "snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    expect(state.entities.project).toMatchObject([
      {
        name: "project",
        roots: [{ path: path.join(fixture.dataDir, "source-home/code/project") }],
      },
    ]);
    expect(state.entities.nativeSession ?? []).toHaveLength(0);
    expect(changes).toEqual([]);
  } finally {
    watcher.close();
    await fixture.cleanup();
  }
});

test("chooses folders through the native boundary and preserves draft and consent on cancellation or failure", async () => {
  const fixture = await launch("doctor"),
    { page, app } = fixture;
  const folder = path.join(fixture.dataDir, "source-home/code");
  try {
    await page.getByRole("button", { name: "Set up coding agents", exact: true }).click();
    await page.getByRole("button", { name: "Get started", exact: true }).click();
    await page.getByRole("button", { name: /^Connect \d+ agents?$/ }).click();
    await page
      .getByRole("button", { name: "Choose sources and folders yourself", exact: true })
      .click();
    await page.getByRole("checkbox", { name: "Scan code folders I choose", exact: true }).check();
    const paths = page.getByRole("textbox", { name: "Code folder paths", exact: true });
    const draft = `  ${folder}  \n`;
    await paths.fill(draft);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole("button", { name: "Choose folders…", exact: true }).click();
    await expect(paths).toBeEnabled();
    await expect(page.getByRole("button", { name: "Choose folders…", exact: true })).toBeFocused();
    await expect(paths).toHaveValue(draft);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => {
        throw new Error("synthetic-private-dialog-error");
      };
    });
    await page.getByRole("button", { name: "Choose folders…", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Folders could not be selected.");
    await expect(page.getByText("synthetic-private-dialog-error", { exact: false })).toHaveCount(0);
    await expect(paths).toHaveValue(draft);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected, selected] });
    }, folder);
    await page.getByRole("button", { name: "Choose folders…", exact: true }).click();
    await expect(paths).toHaveValue(folder);
    await expect(page.getByRole("button", { name: "Choose folders…", exact: true })).toBeFocused();
    const consent = page.getByRole("checkbox", {
      name: "Read metadata from these selected sources and folders",
      exact: true,
    });
    await expect(consent).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Preview metadata", exact: true }),
    ).toBeDisabled();
    const state = (await rpc(page, "snapshot.get", {})) as { entities: Record<string, unknown[]> };
    expect(state.entities.project ?? []).toHaveLength(0);
    expect(state.entities.nativeSession ?? []).toHaveLength(0);
    expect(state.entities.mcpServer ?? []).toHaveLength(0);
    if ((await page.locator("html").getAttribute("data-theme")) !== "light")
      await page.getByRole("button", { name: "Use light theme", exact: true }).click();
    await page.screenshot({ path: "output/playwright/import-folder-picker.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await page.screenshot({
      path: "output/playwright/import-folder-picker-dark.png",
      fullPage: true,
    });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 660, height: 900 });
    await page
      .getByRole("button", { name: "Choose folders…", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "output/playwright/import-folder-picker-narrow.png",
      fullPage: true,
    });
    await consent.check();
    await page.getByRole("button", { name: "Preview metadata", exact: true }).click();
    await expect(
      page
        .getByRole("region", { name: "Metadata preview", exact: true })
        .getByText("Projects: 1", { exact: true }),
    ).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});
