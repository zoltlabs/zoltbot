import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { _electron as electron, expect, type Page } from "@playwright/test";

export const testUiUrl = `http://127.0.0.1:${process.env.ZOLTBOT_E2E_PORT ?? 5187}`;
const require = createRequire(import.meta.url);
const executable = require("../apps/desktop/node_modules/electron") as string;
const defaultSpeechFixture = `
let header = null;
process.stdin.on("data", (chunk) => {
  if (header) return;
  const line = chunk.toString("utf8").split("\\n")[0];
  header = JSON.parse(line);
  if (header.op === "status" || header.op === "request_permission") {
    process.stdout.write(JSON.stringify({
      ok: true,
      microphone: "authorized",
      speech: "authorized",
      available: true,
      onDevice: header.onDevice !== false,
      locale: header.locale || "en-US",
    }) + "\\n");
    process.exit(0);
  }
  const firstHint = Array.isArray(header.contextualStrings) && header.contextualStrings.length
    ? header.contextualStrings[0]
    : "workspace";
  process.stdout.write(JSON.stringify({
    kind: "partial",
    text: "spoken draft for " + firstHint,
  }) + "\\n");
});
process.stdin.on("end", () => {
  if (header && header.op === "stream") {
    const firstHint = Array.isArray(header.contextualStrings) && header.contextualStrings.length
      ? header.contextualStrings[0]
      : "workspace";
    process.stdout.write(JSON.stringify({
      kind: "final",
      text: "spoken final for " + firstHint,
    }) + "\\n");
    process.stdout.write(JSON.stringify({ kind: "stopped" }) + "\\n");
  }
  process.exit(0);
});
`;
export async function launch(
  fixture: boolean | "chat" | "doctor" | "devices" | "browser" | "artifacts" | "knowledge" = false,
  existingDataDir?: string,
  options: {
    historyItems?: number;
    speechHelperCode?: string;
    uiUrl?: string;
  } = {},
) {
  mkdirSync(".cache/e2e", { recursive: true });
  const dataDir = existingDataDir ?? mkdtempSync(path.resolve(".cache/e2e/shell-"));
  const speechHelper = path.join(dataDir, "speech-fixture.cjs");
  writeFileSync(speechHelper, options.speechHelperCode ?? defaultSpeechFixture);
  const started = performance.now();
  const startedWall = Date.now();
  const app = await electron.launch({
    executablePath: executable,
    args: [path.resolve(".cache/desktop/main.cjs")],
    env: {
      ...process.env,
      ZOLTBOT_REPO_ROOT: process.cwd(),
      TMPDIR: dataDir,
      ZOLTBOT_DATA_DIR: dataDir,
      ZOLTBOT_UI_URL: options.uiUrl ?? testUiUrl,
      ZOLTBOT_NODE_BINARY: process.execPath,
      ZOLTBOT_SPEECH_HELPER: speechHelper,
      ZOLTBOT_E2E: "1",
      ...(fixture
        ? {
            ZOLTBOT_TEST_DAEMON_ENTRY: path.resolve(
              typeof fixture === "string"
                ? `.cache/desktop/fixtures/${fixture}-daemon.mjs`
                : ".cache/desktop/fixtures/desktop-daemon.mjs",
            ),
            ...(fixture === "chat"
              ? { ZOLTBOT_TEST_HISTORY_ITEMS: String(options.historyItems ?? 60) }
              : {}),
          }
        : {}),
    },
  });
  const page = await app.firstWindow();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  try {
    await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
  } catch (error) {
    await page.screenshot({ path: "output/playwright/startup-error.png" });
    const content = await page.locator("body").innerText();
    await app.close();
    throw new Error(
      `${String(error)}; renderer: ${problems.join("; ")}; page: ${content.slice(0, 1000)}`,
    );
  }
  const observedStartupMs = performance.now() - started;
  await page.waitForFunction(
    () => performance.getEntriesByName("zoltbot.usable-shell", "mark").length > 0,
  );
  const renderedStartupMs = await page.evaluate((at) => {
    const mark = performance.getEntriesByName("zoltbot.usable-shell", "mark")[0];
    if (!mark) throw new Error("usable_shell_mark_missing");
    return performance.timeOrigin + mark.startTime - at;
  }, startedWall);
  const startupStages = readFileSync(path.join(dataDir, "desktop.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((line) => line.message === "Desktop startup")
    .map((line) => line.detail as { stage: string; elapsedMs: number; atMs: number });
  return {
    startupStages,
    renderedStartupMs,
    app,
    page,
    dataDir,
    startupMs: observedStartupMs,
    cleanup: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          app.close(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              let stages: string[] = [];
              try {
                stages = readFileSync(path.join(dataDir, "desktop.log"), "utf8")
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line).message)
                  .filter((message: string) => /shutdown|quit/.test(message));
              } catch {}
              app.process().kill("SIGKILL");
              reject(new Error(`desktop_close_timeout; stages: ${stages.join(", ")}`));
            }, 10000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!existingDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Open the current chat's explicit details panel before exercising its controls. */
export async function showConversationDetails(page: Page) {
  const toggle = page.getByRole("button", { name: /^(Show|Hide) conversation details$/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(
    page.getByRole("button", { name: "Hide conversation details", exact: true }),
  ).toBeVisible();
}

/** The sidebar intentionally starts with saved workspace navigation folded. */
export async function showWorkspaceTree(page: Page) {
  const tree = page.locator("details.project-tree");
  if (!(await tree.evaluate((node) => (node as HTMLDetailsElement).open)))
    await tree.locator(":scope > summary").click();
  await expect(tree).toHaveJSProperty("open", true);
  const collapsed = tree.getByRole("button", { name: /^Expand / });
  while (await collapsed.count()) await collapsed.first().click();
}

export async function showActivity(page: Page) {
  // Finished turns now fold their tool steps behind "Worked for …" before activity details.
  const turns = page.getByRole("button", { name: /^(Worked|You stopped)/, expanded: false });
  while (await turns.count()) await turns.first().click();
  for (const details of await page.locator("details.activity-details").all()) {
    if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
      await details.locator(":scope > summary").click();
  }
}

export async function navigateMain(page: Page, route: "Tasks" | "Routines") {
  const button = page.getByRole("button", { name: route, exact: true });
  if (!(await button.isVisible()))
    await page
      .getByRole("navigation", { name: "Workspace", exact: true })
      .locator("details > summary")
      .click();
  await button.click();
}

export async function showMessageDetails(page: Page, content: string) {
  const text = page.getByText(content, { exact: true });
  await expect(text).toBeAttached();
  const details = text.locator("xpath=ancestor::details[contains(@class, 'message-details')][1]");
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator(":scope > summary").click();
}

/** Knowledge is opened from the workspace's collapsible Details panel. */
export async function showKnowledge(page: Page) {
  const knowledge = page.getByRole("region", { name: "Knowledge", exact: true });
  if (!(await knowledge.isVisible())) {
    const details = page.getByRole("button", { name: "Details", exact: true });
    await expect(details).toBeVisible();
    if ((await details.getAttribute("aria-expanded")) !== "true") await details.click();
  }
  const show = knowledge.getByRole("button", { name: "Show", exact: true });
  if (await show.isVisible()) await show.click();
  await expect(page.getByRole("button", { name: "New knowledge", exact: true })).toBeVisible();
}
