import { expect, it } from "vitest";
import { compareVersions, supportStatus, versionFromOutput } from "./versions.js";

it("extracts semantic and date based CLI versions without retaining account output", () => {
  expect(versionFromOutput("claude 2.1.299 (Claude Code)\n")).toBe("2.1.299");
  expect(versionFromOutput("2026.10.22-27dcf5f\n")).toBe("2026.10.22-27dcf5f");
  expect(versionFromOutput("2026.11.05-86047df\n")).toBe("2026.11.5-86047df");
  expect(versionFromOutput("not a version")).toBeUndefined();
  expect(compareVersions("2.0.0", "1.99.0")).toBeGreaterThan(0);
});
it("reports tested, newer, older, unknown, and explicitly blocked versions", () => {
  expect(supportStatus("2.1.299", ">=2.1.200 <2.2.0")).toBe("tested");
  expect(supportStatus("2.2.0", ">=2.1.200 <2.2.0")).toBe("newer");
  expect(supportStatus("2.0.0", ">=2.1.200 <2.2.0")).toBe("older");
  expect(supportStatus("2.1.299", "unverified")).toBe("unknown");
  expect(supportStatus(undefined, "2.1.299")).toBe("unknown");
  expect(supportStatus("2.1.299", "2.1.299", ["2.1.299"])).toBe("unsupported");
});
