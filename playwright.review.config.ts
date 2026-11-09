import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/review",
  use: { headless: true, viewport: { width: 1200, height: 900 } },
  webServer: {
    command: "node_modules/.bin/vite --config tests/review/vite.config.ts",
    url: "http://127.0.0.1:5193/tests/review/",
    reuseExistingServer: false,
  },
});
