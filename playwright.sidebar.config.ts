import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/sidebar",
  timeout: 60000,
  workers: 1,
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  outputDir: "output/playwright/sidebar-results",
  reporter: [["list"]],
  webServer: {
    command: "pnpm dev:ui --port 5196",
    url: "http://127.0.0.1:5196",
    reuseExistingServer: true,
  },
});
