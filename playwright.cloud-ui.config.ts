import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/cloud-ui",
  testMatch: "**/*.spec.ts",
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  outputDir: "output/playwright/cloud-ui-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/cloud-ui-report", open: "never" }],
  ],
  use: {
    headless: true,
    baseURL: "http://127.0.0.1:5191",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1024, height: 900 },
  },
  webServer: {
    command: "pnpm exec vite --config tests/cloud-ui/vite.config.ts",
    url: "http://127.0.0.1:5191/tests/cloud-ui/",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
