import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "composer.spec.ts",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  outputDir: "output/playwright/composer-results",
  use: {
    headless: true,
    baseURL: "http://127.0.0.1:5197",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev:ui --port 5197",
    url: "http://127.0.0.1:5197/composer-preview.html",
    reuseExistingServer: false,
  },
});
