import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";

test("scans real fake executables, ignores a broken install, and notices removal on rescan", async () => {
  const fixture = await launch("doctor"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Coding agents", exact: true }).click();
    // The launch-time update check may already have scanned, so the empty state is not guaranteed.
    await expect(
      page.getByRole("heading", { name: "Coding agents", exact: true, level: 2 }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Scan coding tools", exact: true }).click();
    const tool = page.getByRole("article", {
      name: "Fixture coding tool diagnostics",
      exact: true,
    });
    await expect(tool.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(tool).toContainText("1.0.0 · Tested version");
    await expect(tool.locator("code").first()).toHaveText(
      path.join(fixture.dataDir, "bin-working/sample"),
    );
    await tool.getByText("All detected installs (2)", { exact: true }).click();
    await expect(tool.getByText("Ignored: broken install", { exact: false })).toBeVisible();
    await tool.getByText("Declared capabilities", { exact: true }).click();
    await expect(tool.getByText("Queued", { exact: true })).toBeVisible();
    await expect(tool).not.toContainText("synthetic-private-broken-detail");
    if ((await page.locator("html").getAttribute("data-theme")) !== "light")
      await page.getByRole("button", { name: "Use light theme", exact: true }).click();
    await page.screenshot({ path: "output/playwright/doctor-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "output/playwright/doctor-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page
      .getByRole("region", { name: "Workspace checks", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: "output/playwright/doctor-checks-dark.png", fullPage: true });
    rmSync(path.join(fixture.dataDir, "bin-working/sample"));
    await page.getByRole("button", { name: "Scan coding tools", exact: true }).click();
    await expect(tool.getByText("Not found", { exact: true })).toBeVisible();
    writeFileSync(path.join(fixture.dataDir, "fail-report"), "1");
    await page.getByRole("button", { name: "Scan coding tools", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("could not be refreshed");
    await expect(tool.getByText("Not found", { exact: true })).toBeVisible();
    const calls = readFileSync(path.join(fixture.dataDir, "native-checks.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.length).toBeGreaterThan(2);
    expect(
      calls.every(
        (args) =>
          JSON.stringify(args) === '["--version"]' || JSON.stringify(args) === '["auth","status"]',
      ),
    ).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});
