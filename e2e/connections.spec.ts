import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { launch, showWorkspaceTree } from "./desktop.js";

/** The theme radios live on Settings › General, so other tabs switch theme from the header. */
async function applyTheme(page: Page, theme: string) {
  const value = theme.toLowerCase();
  if ((await page.locator("html").getAttribute("data-theme")) !== value)
    await page.getByRole("button", { name: `Use ${value} theme`, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", value);
}

test("adds a disabled connection, confirms profile access and disconnects in both themes", async () => {
  const fixture = await launch("chat");
  const { page } = fixture;
  try {
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Connection project");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    const connections = page.getByRole("region", { name: "Connections", exact: true });
    await connections.getByText("Advanced MCP · Add or import a server", { exact: true }).click();
    await connections.getByLabel("Name", { exact: true }).fill("docs-service");
    await connections.getByLabel("Remote URL", { exact: true }).fill("https://mcp.example.com/mcp");
    await connections
      .getByLabel("Workspace", { exact: true })
      .selectOption({ label: "Connection project" });
    await connections.getByRole("button", { name: "Add disabled connection", exact: true }).click();
    await expect(connections.getByText(/Disabled · v1/)).toBeVisible();
    await connections.getByRole("button", { name: "docs-service", exact: true }).focus();
    await page.keyboard.press("Enter");
    await connections.getByLabel("Enabled for new sessions", { exact: true }).check();
    await connections
      .getByRole("group", { name: "Profiles that can use this" })
      .getByRole("checkbox")
      .first()
      .check();
    await connections.getByRole("button", { name: "Save access", exact: true }).click();
    await expect(connections.getByRole("alert")).toBeVisible();
    for (const theme of ["Light", "Dark"]) {
      await applyTheme(page, theme);
      expect(
        (await new AxeBuilder({ page }).include(".connections-settings").setLegacyMode().analyze())
          .violations,
      ).toEqual([]);
      await connections.screenshot({
        path: `output/playwright/connections-error-${theme.toLowerCase()}.png`,
      });
    }
    await connections
      .getByLabel("I approve giving these profiles access to this server’s tools.", { exact: true })
      .check();
    await connections.getByRole("button", { name: "Save access", exact: true }).click();
    await expect(connections.getByText(/No sign-in required · v2/)).toBeVisible();
    await connections.getByRole("button", { name: "Disconnect…", exact: true }).click();
    const confirmation = connections.getByRole("region", {
      name: "Confirm disconnect",
      exact: true,
    });
    await expect(confirmation).toContainText("No active native sessions");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await connections.getByRole("button", { name: "Disconnect…", exact: true }).click();
    await confirmation.getByRole("button", { name: "Confirm disconnect", exact: true }).click();
    await expect(connections.getByText(/Disabled · v3/)).toBeVisible();
    for (const theme of ["Light", "Dark"]) {
      await applyTheme(page, theme);
      expect(
        (await new AxeBuilder({ page }).include(".connections-settings").setLegacyMode().analyze())
          .violations,
      ).toEqual([]);
      await connections.screenshot({
        path: `output/playwright/connections-${theme.toLowerCase()}.png`,
      });
    }
  } finally {
    await fixture.cleanup();
  }
});
