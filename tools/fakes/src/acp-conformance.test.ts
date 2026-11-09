import { runConformance, scenarios } from "@zoltbot/adapters-sdk/conformance";
import { describe, expect, it, vi } from "vitest";
import { acpFactory } from "./acp-conformance-factory.js";

const factory = acpFactory();
describe("ACP shared adapter conformance", () => {
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
