import { defineConfig } from "@playwright/test";
import base from "./playwright.shipping.config.js";

// Dedicated artifact directories keep this headless suite from replacing shipping evidence.
export default defineConfig({
  ...base,
  testMatch: "event-routines.spec.ts",
  outputDir: "output/playwright/event-routines-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/event-routines-report", open: "never" }],
  ],
});
