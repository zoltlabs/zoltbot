import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { startDaemon } from "../../packages/daemon/src/api.js";
import type { SetupService } from "../../packages/daemon/src/setup-api.js";

const antigravity = {
  definitionId: "antigravity",
  displayName: "Antigravity",
  installed: "1.5.1",
  latest: "1.5.2",
  command: ["agy", "update"],
};
const codex = {
  definitionId: "codex",
  displayName: "Codex",
  installed: "0.166.0",
  latest: "0.167.0",
  command: ["codex", "update"],
};

async function fixture() {
  await mkdir(".cache/e2e", { recursive: true });
  const root = await mkdtemp(path.resolve(".cache/e2e/updates-"));
  let rows = [antigravity, codex];
  const runs: string[] = [];
  let release: () => void = () => {};
  const setup: SetupService = {
    scan: async () => [],
    definitions: async () => ({ definitions: [] }),
    login: async () => ({ state: "unknown" }),
    imports: {
      preview: async () => ({ id: "preview", items: [] }),
      apply: async () => ({}),
    },
    report: async () => ({ checks: [] }),
    fix: async () => ({}),
    upsert: async (value) => value,
    probe: async () => ({}),
    updates: async () => rows,
    update: async (id, confirmed) => {
      if (!confirmed) throw new Error("update_confirmation_required");
      runs.push(id);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      rows = rows.filter((row) => row.definitionId !== id);
      return { version: "1.5.2" };
    },
  };
  const daemon = await startDaemon({ dataDir: root, origins: ["http://127.0.0.1:5190"], setup });
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.ZOLTBOT_HEADLESS_CHROMIUM ??
      (existsSync(chromium.executablePath())
        ? chromium.executablePath()
        : path.join(
            homedir(),
            "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
          )),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(
    ({ url, token }) => {
      window.zoltDesktop = {
        connection: async () => ({ url, token }),
        onConnectionChanged: () => () => {},
        visibleThread() {},
      };
    },
    { url: daemon.url, token: daemon.token },
  );
  const page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5190/#settings");
  await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
  return {
    page,
    errors,
    runs,
    finish: () => release(),
    async close() {
      await browser.close();
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("update card runs the provider's update, hides dismissed versions and can be turned off", async () => {
  const f = await fixture(),
    page = f.page;
  try {
    const card = page.getByRole("region", { name: "Antigravity update available" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("1.5.1");
    await expect(card).toContainText("1.5.2");
    await expect(card.getByText("agy update")).toBeVisible();
    for (const theme of ["Light", "Dark"]) {
      await page.getByRole("radio", { name: theme, exact: true }).check();
      const scan = await new AxeBuilder({ page }).include(".update-notice").analyze();
      expect(scan.violations).toEqual([]);
      await card.screenshot({
        path: `output/playwright/updates-results/update-card-${theme.toLowerCase()}.png`,
      });
    }

    await card.getByRole("button", { name: "Update", exact: true }).click();
    await expect(card.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(f.runs).toEqual(["antigravity"]);
    f.finish();

    const next = page.getByRole("region", { name: "Codex update available" });
    await expect(next).toBeVisible();
    await expect(card).toHaveCount(0);
    await next.getByRole("button", { name: "Dismiss Codex 0.167.0" }).click();
    await expect(next).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
    await expect(page.locator(".update-notice")).toHaveCount(0);

    const toggle = page.getByRole("checkbox", { name: "Check for coding tool updates once a day" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
