import { defineConfig } from "@playwright/test";

const port = Number(process.env.ZOLTBOT_FORK_TEST_PORT ?? "5191");
export default defineConfig({
  testDir: "./tests/forks",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  outputDir: "output/playwright/forks-results",
  reporter: [["list"], ["html", { outputFolder: "output/playwright/forks-report", open: "never" }]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: `pnpm dev:ui --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 20000,
  },
});
