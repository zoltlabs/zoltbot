import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [solidPlugin()],
        test: {
          name: "renderer",
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/renderer/src/setupTests.ts"],
        },
      },
      {
        // Main-process code runs on Node with a real daemon, so it needs Node's module conditions.
        test: {
          name: "main",
          include: ["src/main/**/*.test.ts", "src/zolt/**/*.test.ts"],
          environment: "node",
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
