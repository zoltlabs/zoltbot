import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Quick Chat in headless Chromium against a real daemon and deterministic fake providers. No
// Electron window opens and no request reaches a real model provider.
const uiUrl = `http://127.0.0.1:${process.env.ZOLTBOT_E2E_PORT ?? 5187}`;
const apiKey = "sk-user-synthetic";
let daemon: ChildProcess | undefined;
let dataDir = "";
let info: { url: string; token: string };
let providers: { url: string };

test.beforeAll(async () => {
  mkdirSync(".cache/tests", { recursive: true });
  dataDir = mkdtempSync(path.resolve(".cache/tests/quick-chat-e2e-"));
  daemon = spawn(process.execPath, ["--import", "tsx", "tools/fakes/src/quick-chat-daemon.ts"], {
    env: { ...process.env, ZOLTBOT_DATA_DIR: dataDir, ZOLTBOT_UI_ORIGIN: uiUrl },
    stdio: "inherit",
  });
  await expect
    .poll(() => existsSync(path.join(dataDir, "providers.json")), { timeout: 20_000 })
    .toBe(true);
  info = JSON.parse(readFileSync(path.join(dataDir, "daemon.json"), "utf8"));
  providers = JSON.parse(readFileSync(path.join(dataDir, "providers.json"), "utf8"));
});
test.afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((done) => daemon?.once("exit", done));
    daemon.kill("SIGTERM");
    await exited;
  }
  rmSync(dataDir, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript((connection) => {
    window.zoltDesktop = {
      connection: async () => connection,
      onConnectionChanged: () => () => {},
      openExternal: async () => {},
    } as unknown as NonNullable<typeof window.zoltDesktop>;
  }, info);
});

test("quick chat runs on the person's own connections with explicit context", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`${uiUrl}/#quick`);
  const main = page.getByRole("region", { name: "Quick chat", exact: true });
  await expect(main.getByRole("heading", { name: "Quick chat", exact: true })).toBeVisible();
  // The composer is ready to type into immediately.
  await expect(main.getByLabel("Message")).toBeFocused();
  // Coding tools signed in on the host are used automatically, with nothing to set up first.
  await expect(main.getByRole("list", { name: "Suggestions" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Quick Chat connections" })).toHaveCount(0);
  const composer = page.getByRole("form", { name: "Quick chat composer" });
  await expect(composer.getByLabel("Coding tool")).toHaveValue(/.+/);
  await expect(composer.getByLabel("Coding tool")).toHaveAttribute(
    "title",
    "Your Antigravity sign-in · Fixture Mac",
  );
  const message = composer.getByLabel("Message");
  await message.fill("Hi from a tool");
  await message.press("Enter");
  const messages = main.locator(".quick-messages");
  // The tool asks before sending an email; nothing happens until the person allows it.
  const request = messages.getByRole("region", { name: "Request waiting for you" });
  await expect(request).toContainText("Send an email");
  await expect(request).toContainText("Tool: gmail: send message");
  await request.getByRole("button", { name: "Allow once" }).click();
  await expect(messages).toContainText("Echo: Hi from a tool (sent)");
  await expect(messages).toContainText("Allowed: Send an email");
  await expect(messages.locator(".quick-reply-meta").first()).toContainText(
    "gemini-3.8-flash · Your Antigravity sign-in · Fixture Mac",
  );
  await main.getByRole("button", { name: "New chat" }).click();
  await expect(messages).not.toContainText("Echo: Hi from a tool");

  await main.getByRole("button", { name: "Quick Chat settings" }).click();
  const settings = page.getByRole("dialog", { name: "Quick Chat settings" });
  const setup = settings.getByRole("region", { name: "Quick Chat connections" });
  await expect(setup).toContainText("Signed-in coding tools on Fixture Mac connect automatically.");
  await expect(settings).toHaveCSS("width", "760px");
  await settings.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "Connected tools" })).toBeVisible();
  await expect(setup.getByRole("list", { name: "Your MCP servers" })).toBeVisible();
  await settings.getByRole("button", { name: "Fallback", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "Automatic fallback" })).toBeVisible();
  await settings.getByRole("button", { name: "Connections", exact: true }).click();
  await settings.screenshot({ path: "output/playwright/quick-settings-wide.png" });
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(settings).toBeVisible();
  expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await settings.screenshot({ path: "output/playwright/quick-settings-narrow.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await setup.getByText("Add an API key or local model").click();

  // The person's own API key: stored on the host, never shown to the page again.
  const keyForm = setup.getByRole("form", { name: "Your API key" });
  await keyForm.getByLabel("API key").fill(apiKey);
  await keyForm.getByRole("button", { name: "Save key" }).click();
  await expect(setup.getByText("Key saved to the Keychain.")).toBeVisible();
  await expect(keyForm.getByLabel("API key")).toHaveValue("");

  // A local endpoint on this machine.
  const localForm = setup.getByRole("form", { name: "Local model" });
  await localForm.getByLabel("Name").fill("Fixture local");
  await localForm.getByLabel("Endpoint URL").fill(`${providers.url}/v1`);
  await localForm.getByRole("button", { name: "Save endpoint" }).click();
  await expect(setup.getByText("Local endpoint saved.")).toBeVisible();

  await settings.getByRole("button", { name: "Done" }).click();
  await composer.getByLabel("Coding tool").selectOption({ label: "Fixture local" });
  await main.getByRole("button", { name: "Quick Chat settings" }).click();
  await settings.locator(".quick-model-row").getByRole("combobox").selectOption("fake-fast");
  await expect(settings).toContainText("Local model · Fixture local · Fixture Mac");
  await settings.getByRole("button", { name: "Done" }).click();

  // First send creates the chat and streams the reply with its attribution.
  await message.fill("Hello");
  await message.press("Enter");
  await expect(messages).toContainText("Echo: Hello");
  await expect(messages.locator(".quick-reply-meta").first()).toContainText(
    "fake-fast · Local model · Fixture local · Fixture Mac",
  );
  // History lives in the main sidebar.
  const recent = page.locator("details.quick-history");
  await expect(recent.getByRole("button", { name: "Hello", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#quick\/.+/);

  // Context is chosen separately from the connection and shows as removable chips.
  await composer.getByRole("button", { name: "Add context" }).click();
  const picker = composer.getByRole("region", { name: "Add context" });
  await picker.getByLabel("Workspace").selectOption({ label: "Zolt" });
  await picker.getByLabel("Find a file").fill("billing");
  await picker.getByRole("button", { name: "docs/billing.md" }).click();
  await picker.getByRole("button", { name: "Search @Zolt" }).click();
  const chips = composer.getByRole("list", { name: "Context sources" });
  await expect(chips.getByRole("listitem")).toHaveCount(2);
  await message.fill("How are invoices sent?");
  await message.press("Enter");
  await expect(messages).toContainText("Echo: How are invoices sent?");
  await expect(messages).toContainText("Context used: docs/billing.md");
  await chips.getByRole("button", { name: /^Remove .*billing/ }).click();
  await expect(chips.getByRole("listitem")).toHaveCount(1);

  // Drafts survive a reload.
  await message.fill("Unsent thought");
  await page.reload();
  await expect(composer.getByLabel("Message")).toHaveValue("Unsent thought");
  await expect(messages).toContainText("Echo: How are invoices sent?");

  // Rename.
  await recent.getByLabel("Actions for Hello").click();
  await recent.getByRole("button", { name: "Rename Hello" }).click();
  await recent.getByLabel("Chat name").fill("Billing questions");
  await recent.getByRole("button", { name: "Save name" }).click();
  await expect(main.getByRole("heading", { name: "Billing questions" })).toBeVisible();

  // The API key never reaches page state or storage.
  expect(await page.content()).not.toContain(apiKey);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(apiKey);

  // Continue in workspace creates a normal chat with the brief waiting, unsent.
  await main.getByRole("button", { name: "Continue in workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Continue in workspace" });
  await expect(dialog.getByLabel("Brief")).toHaveValue(/How are invoices sent\?/);
  await dialog.getByRole("button", { name: "Create workspace chat" }).click();
  await expect(page).not.toHaveURL(/#quick/);
  await expect(page.locator("textarea").first()).toHaveValue(/How are invoices sent\?/);

  // The original chat stays and links to the workspace chat.
  const handoffUrl = page.url();
  await page.goBack();
  await expect(main.getByRole("heading", { name: "Billing questions" })).toBeVisible();
  await main.getByRole("button", { name: "Open workspace chat" }).click();
  await expect(page).toHaveURL(handoffUrl);

  // Delete removes the chat.
  await page.goto(`${uiUrl}/#quick`);
  await recent.getByLabel("Actions for Billing questions").click();
  await recent.getByRole("button", { name: "Delete Billing questions" }).click();
  await expect(recent.getByRole("button", { name: "Billing questions" })).toHaveCount(0);
  await expect(recent.getByRole("button", { name: "Hi from a tool", exact: true })).toBeVisible();
});
