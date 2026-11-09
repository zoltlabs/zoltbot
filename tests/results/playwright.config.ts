import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 30000,
  outputDir: "../../output/playwright/results",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(process.env.ZOLTBOT_HEADLESS_CHROMIUM
      ? { launchOptions: { executablePath: process.env.ZOLTBOT_HEADLESS_CHROMIUM } }
      : {}),
  },
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: "pnpm exec vite --config tests/results/vite.config.ts",
    url: "http://127.0.0.1:5197/tests/results/",
    reuseExistingServer: false,
  },
});
