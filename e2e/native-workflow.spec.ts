import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
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

test("normal desktop connects Claude and Codex, answers questions and approvals, delegates and resumes", async () => {
  test.setTimeout(45000);
  mkdirSync(".cache/e2e", { recursive: true });
  const directory = mkdtempSync(path.resolve(".cache/e2e/native-workflow-"));
  execFileSync(
    process.execPath,
    ["--import", "tsx", "tools/fakes/src/seed-native-desktop.ts", directory],
    { env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
  );
  let fixture = await launch(false, directory),
    page = fixture.page;
  try {
    await hideQuickChatTools(fixture.page);
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Claude workflow", exact: true }).click();
    await showConversationDetails(page);
    await page.getByRole("button", { name: "Show sign-in command", exact: true }).click();
    await expect(page.getByRole("region", { name: "Provider sign-in" })).toContainText(
      path.join(directory, "providers/claude"),
    );
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Message Claude", exact: true });
    await expect(editor).toBeEnabled();
    await editor.fill("question");
    await editor.press("Enter");
    const request = page.getByRole("region", { name: "Pending request", exact: true });
    await expect(request).toContainText("Choose");
    await request.getByRole("checkbox", { name: /A/ }).check();
    await request.getByRole("button", { name: "Next", exact: true }).click();
    await request
      .getByRole("textbox", { name: "Your answer", exact: true })
      .fill("Check food units.");
    await request.getByRole("button", { name: "Review answers", exact: true }).click();
    await request.getByRole("button", { name: "Send answers", exact: true }).click();
    await expect(request).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await editor.fill("approval");
    await editor.press("Enter");
    await request.getByRole("button", { name: /^Approve/ }).click();
    await expect(request).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await editor.fill("delegate_codex");
    await editor.press("Enter");
    await expect(page.getByRole("button", { name: "Feature check", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Feature check", exact: true }).click();
    await expect(page.getByRole("article", { name: /^From .+ \(manager\)$/ })).toContainText(
      "Check the feature and return a brief result.",
    );
    await expect(page.getByRole("textbox", { name: "Message Codex", exact: true })).toBeEnabled();
    await expect(
      page
        .getByRole("region", { name: "Conversation", exact: true })
        .getByRole("article", { name: "Your message", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Conversation", exact: true })).toHaveCount(1);
    const childId = decodeURIComponent(new URL(page.url()).hash.slice("#chat/".length));
    expect(
      await page
        .locator(".chat-virtual-row")
        .evaluateAll(
          (rows, id) => rows.every((row) => row.getAttribute("data-thread-id") === id),
          childId,
        ),
    ).toBe(true);
    await page.screenshot({
      path: "output/playwright/native-workflow-delegated.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Codex workflow", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const codex = page.getByRole("textbox", { name: "Message Codex", exact: true });
    await codex.fill("hello");
    await codex.press("Enter");
    await expect(page.getByText("ok", { exact: true }).last()).toBeVisible();
    await fixture.app.close();
    fixture = await launch(false, directory);
    page = fixture.page;
    await showWorkspaceTree(page);
    await page.getByRole("button", { name: "Codex workflow", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex", exact: true })).toBeEnabled();
    await expect(page.getByText("hello", { exact: true })).toHaveCount(1);
  } finally {
    await fixture.cleanup();
  }
});
