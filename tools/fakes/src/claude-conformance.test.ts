import { runConformance, scenarios } from "@zoltbot/adapters-sdk/conformance";
import { describe, expect, it, vi } from "vitest";
import { claudeFactory as factory } from "./claude-conformance-factory.js";

describe("Claude shared adapter conformance", () => {
  for (const scenario of scenarios)
    it(scenario, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runConformance(factory, scenario);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
});
