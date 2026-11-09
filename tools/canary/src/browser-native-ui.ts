import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { launch, testUiUrl } from "../../../e2e/desktop.js";

// Reads only the disposable native-canary database; does not start a model turn.
const { root } = JSON.parse(readFileSync(".cache/browser-product-last.json", "utf8")) as {
  root: string;
};
const port = new URL(testUiUrl).port;
const ui = spawn(
  process.execPath,
  [
    path.resolve("node_modules/vite/bin/vite.js"),
    "--config",
    "packages/ui/vite.config.ts",
    "--port",
    port,
  ],
  { stdio: "ignore" },
);
let app: Awaited<ReturnType<typeof launch>> | undefined;
try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(testUiUrl)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  app = await launch(false, root);
  const { page } = app;
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  const gallery = page.getByRole("region", { name: /^Browser evidence for / }).first();
  const image = gallery.getByRole("img").first();
  await expect(image).toBeVisible();
  expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(600);
  await gallery
    .getByRole("button", { name: /Open evidence from revision/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("img", { name: "Full browser evidence", exact: true })
    .screenshot({ path: "output/playwright/browser-native-capture.png" });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "output/playwright/browser-native-dark.png", fullPage: true });
  expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(gallery.getByRole("img").first()).toBeVisible();
  await page.screenshot({ path: "output/playwright/browser-native-light.png", fullPage: true });
  expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  writeFileSync(
    ".cache/browser-native-ui.json",
    JSON.stringify(
      {
        passed: true,
        root,
        imagePixelsDecoded: true,
        fullImage: true,
        light: true,
        dark: true,
        axeViolations: 0,
      },
      null,
      2,
    ),
  );
  console.log("Native registered image display: PASS");
} finally {
  if (app) await app.app.close();
  ui.kill("SIGTERM");
}
