import { afterAll, describe, it } from "vitest";
import { runConformance, scenarios } from "../../conformance/index.js";
import { createFakeTarget } from "./index.js";

const target = createFakeTarget({ root: ".cache/tests/sandbox-fake" });
afterAll(() => target.dispose());

describe("fake execution target", () => {
  it.each(scenarios)("passes conformance: %s", (scenario) => runConformance(target, scenario));
});
