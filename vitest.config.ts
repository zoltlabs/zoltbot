import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vitest",
  test: {
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "tools/**/*.test.ts",
      "services/relay/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
    reporters: ["default", "json"],
    outputFile: ".cache/test-results/vitest.json",
  },
});
