import { randomBytes } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Ephemeral test-only credential, never persisted or printed.
const serviceKey = randomBytes(32).toString("base64url");
process.env.ORCHESTRATOR_SIGNING_KEY = serviceKey;
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ORCHESTRATOR_SIGNING_KEY: serviceKey } },
    }),
  ],
  test: { include: ["test-runtime/**/*.test.ts"], maxWorkers: 1, testTimeout: 30000 },
});
