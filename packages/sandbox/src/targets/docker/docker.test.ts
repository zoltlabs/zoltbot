import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConformance, scenarios } from "../../conformance/index.js";
import { createDockerTarget, dockerAvailable } from "./index.js";

// Runs whenever a docker daemon answers. ZOLTBOT_TEST_DOCKER=1 makes the daemon required, so a
// missing daemon fails the run instead of skipping it.
const required = process.env.ZOLTBOT_TEST_DOCKER === "1";
const available = required || (await dockerAvailable());
const target = createDockerTarget({ label: "conformance" });

describe.skipIf(!available)("docker execution target", () => {
  beforeAll(async () => {
    expect(await dockerAvailable()).toBe(true);
    await target.removeAll();
    await target.pull();
  }, 600_000);
  afterAll(async () => {
    if (available) await target.removeAll();
  }, 120_000);

  it.each(scenarios)(
    "passes conformance: %s",
    (scenario) => runConformance(target, scenario),
    120_000,
  );
});
