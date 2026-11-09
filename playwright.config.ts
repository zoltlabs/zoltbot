import { defineConfig } from "@playwright/test";

const port = Number(process.env.ZOLTBOT_E2E_PORT ?? 5187);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_e2e_port");
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "output/playwright/results",
  reporter: [["list"], ["html", { outputFolder: "output/playwright/report", open: "never" }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: `pnpm dev:ui --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    timeout: 15000,
    reuseExistingServer: false,
  },
});
