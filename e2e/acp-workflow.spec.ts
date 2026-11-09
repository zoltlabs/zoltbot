import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { launch, showConversationDetails, showWorkspaceTree } from "./desktop.js";
import { rpc } from "./rpc.js";

/**
 * This spec runs the real daemon, so Quick Chat would find the coding tools installed on this
 * machine and the project-chat router would classify each message with one of them. Hiding those
 * connections keeps every turn on the seeded synthetic providers.
 */
async function hideQuickChatTools(page: Page) {
  const { items } = (await rpc(page, "quickConnection.list", {})) as {
    items: { id: string; kind: string }[];
  };
  for (const item of items)
    if (item.kind === "coding_tool")
      await rpc(page, "quickConnection.remove", { id: item.id, confirmed: true });
}

test("ACP providers use the normal chat, approval, sign-in and resume UI", async () => {
  test.setTimeout(120000);
  mkdirSync(".cache/e2e", { recursive: true });
  const directory = mkdtempSync(path.resolve(".cache/e2e/acp-workflow-"));
  execFileSync(
    process.execPath,
    ["--import", "tsx", "tools/fakes/src/seed-native-desktop.ts", directory, "--acp"],
    { env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
  );
  let fixture = await launch(false, directory);
  try {
    await hideQuickChatTools(fixture.page);
    await fixture.page.getByRole("button", { name: "Settings", exact: true }).click();
    await fixture.page.getByRole("radio", { name: "Light", exact: true }).check();
    for (const name of ["Cursor", "Antigravity", "OpenCode", "GitHub Copilot"]) {
      const page = fixture.page;
      await showWorkspaceTree(page);
      await page.getByRole("button", { name: `${name} workflow`, exact: true }).click();
      await showConversationDetails(page);
      const access = page.getByRole("region", { name: "Provider sign-in" });
      await expect(access.getByRole("heading")).toHaveText(`${name} sign-in`);
      await access.getByRole("button", { name: "Show sign-in command", exact: true }).click();
      await expect(access.locator("pre")).toContainText(
        `${({ "GitHub Copilot": "copilot" } as Record<string, string>)[name] ?? name.toLowerCase()}-synthetic.mjs`,
      );
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const editor = page.getByRole("textbox", { name: `Message ${name}`, exact: true });
      await expect(editor).toBeEnabled();
      await editor.fill("approval");
      await editor.press("Enter");
      const request = page.getByRole("region", { name: "Pending request", exact: true });
      await expect(request.getByRole("button", { name: /^Approve/ })).toBeVisible();
      await page.screenshot({
        path: `output/playwright/${name.toLowerCase()}-approval.png`,
        fullPage: true,
      });
      expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
      await request.getByRole("button", { name: /^Approve/ }).click();
      await expect(request).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await editor.fill("tools");
      await editor.press("Enter");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      if (name === "Cursor") {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("radio", { name: "Dark", exact: true }).check();
      }
    }
    await fixture.app.close();
    fixture = await launch(false, directory);
    const page = fixture.page;
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Antigravity workflow", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Message Antigravity", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText("approval", { exact: true })).toHaveCount(1);
  } finally {
    await fixture.cleanup();
  }
});
