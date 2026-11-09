import { describe, it } from "vitest";
import { runConformance, scenarios } from "../../conformance/index.js";
import { createE2bTarget } from "./index.js";

// Opt-in: runs only with E2B_API_KEY set in the environment. The key is never committed, printed
// or written to test output (I7). E2B_TEMPLATE picks a template; the SDK default is "base".
const apiKey = process.env.E2B_API_KEY;

describe.skipIf(!apiKey)("e2b execution target against the hosted service", () => {
  const target = apiKey
    ? createE2bTarget({
        apiKey,
        timeoutMs: 600_000,
        ...(process.env.E2B_TEMPLATE ? { template: process.env.E2B_TEMPLATE } : {}),
      })
    : undefined;
  it.each(scenarios)("passes conformance: %s", async (scenario) => {
    if (target) await runConformance(target, scenario, { slow: 3 });
  }, 180_000);
});
