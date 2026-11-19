import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  outputDir: "../../output/playwright/shell",
  reporter: [["list"]],
  use: {
    headless: true,
    colorScheme: "dark",
    viewport: { width: 1280, height: 820 },
    trace: "retain-on-failure",
  },
});
