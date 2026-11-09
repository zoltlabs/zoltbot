import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/compare",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  outputDir: "output/playwright/compare-results",
  reporter: [["list"]],
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "pnpm dev:ui --port 5196",
    url: "http://127.0.0.1:5196",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
