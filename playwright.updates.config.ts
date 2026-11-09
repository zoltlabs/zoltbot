import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/updates",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  outputDir: "output/playwright/updates-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/updates-report", open: "never" }],
  ],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: "pnpm dev:ui --port 5190",
    url: "http://127.0.0.1:5190",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
