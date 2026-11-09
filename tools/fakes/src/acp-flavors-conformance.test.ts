import { runConformance, scenarios } from "@zoltbot/adapters-sdk/conformance";
import { describe, expect, it, vi } from "vitest";
import { acpFactory } from "./acp-conformance-factory.js";

for (const flavor of ["cursor", "antigravity", "opencode", "grok", "copilot"])
  describe(`${flavor} ACP conformance`, () => {
    for (const scenario of scenarios)
      it(scenario, async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await runConformance(acpFactory(flavor), scenario);
          expect(errors).not.toHaveBeenCalled();
        } finally {
          errors.mockRestore();
        }
      });
  });
