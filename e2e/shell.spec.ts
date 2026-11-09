import { readFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";

test("shell navigation, themes, palette, and accessibility", async () => {
  const fixture = await launch();
  const { page } = fixture;
  try {
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true, level: 1 }),
    ).toBeVisible();
    // Overview and Needs you stay visible; More exposes Tasks and Routines.
    await expect(
      page.getByRole("navigation", { name: "Workspace" }).getByRole("button"),
    ).toHaveCount(2);
    await page.getByRole("navigation", { name: "Workspace" }).locator("details > summary").click();
    await expect(
      page.getByRole("navigation", { name: "Workspace" }).getByRole("button"),
    ).toHaveCount(4);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "output/playwright/shell-dark.png", fullPage: true });
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({ path: "output/playwright/shell-light.png", fullPage: true });
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "Search and commands" })).toBeVisible();
    await page.getByRole("textbox", { name: "Search commands" }).fill("Needs");
    await page.getByRole("button", { name: "Open Needs you", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Nothing needs you" })).toBeVisible();
    await page.getByRole("separator", { name: "Sidebar width" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("separator", { name: "Sidebar width" })).toHaveAttribute(
      "aria-valuenow",
      "248",
    );
    const accessibility = await new AxeBuilder({ page }).setLegacyMode().analyze();
    expect(accessibility.violations).toEqual([]);
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    ).toBe("undefined");
  } finally {
    await fixture.cleanup();
  }
});
test("renderer crash preserves daemon and daemon crash reconnects automatically", async () => {
  const fixture = await launch();
  const { app, dataDir } = fixture;
  let page = fixture.page;
  try {
    const first = JSON.parse(readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      pid: number;
    };
    const replacement = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
    });
    page = await replacement;
    await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
    const afterRenderer = JSON.parse(readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      pid: number;
    };
    expect(afterRenderer.pid).toBe(first.pid);
    process.kill(first.pid, "SIGKILL");
    await expect(
      page.getByText("Reconnecting to the Zoltbot daemon", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
    const restarted = JSON.parse(readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      pid: number;
    };
    expect(restarted.pid).not.toBe(first.pid);
  } finally {
    await fixture.cleanup();
  }
});
test("tray and dock count follow durable interaction changes", async () => {
  const fixture = await launch(true);
  const { app, page } = fixture;
  try {
    const needsYou = page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("button", { name: "Needs you", exact: true });
    await expect(needsYou).toHaveText("Needs you1");
    await expect.poll(() => app.evaluate(({ app }) => app.dock?.getBadge())).toBe("1");
    await expect(needsYou).toHaveText("Needs you", { timeout: 16000 });
    await expect.poll(() => app.evaluate(({ app }) => app.dock?.getBadge())).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

test("main process crash leaves the daemon available for a new desktop instance", async () => {
  const first = await launch();
  const original = JSON.parse(readFileSync(path.join(first.dataDir, "daemon.json"), "utf8")) as {
    pid: number;
  };
  const closed = first.app.waitForEvent("close");
  first.app.process().kill("SIGKILL");
  await closed;
  const second = await launch(false, first.dataDir);
  try {
    const attached = JSON.parse(readFileSync(path.join(second.dataDir, "daemon.json"), "utf8")) as {
      pid: number;
    };
    expect(attached.pid).toBe(original.pid);
    await expect(second.page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
  } finally {
    await second.cleanup();
  }
});
