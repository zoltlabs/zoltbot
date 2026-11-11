import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium, defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 30000,
  outputDir: "../../output/playwright/views",
  reporter: [["list"]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath:
        process.env.ZOLTBOT_HEADLESS_CHROMIUM ??
        (existsSync(chromium.executablePath())
          ? chromium.executablePath()
          : path.join(
              homedir(),
              "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
            )),
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
});
