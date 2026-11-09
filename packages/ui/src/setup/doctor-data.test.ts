import { expect, it } from "vitest";
import { capabilityRows, doctorChecks, loginLabel, supportLabel } from "./doctor-data.js";

it("keeps unknown diagnostic states distinct from supported capabilities and successful login", () => {
  expect(
    capabilityRows({ resume: true, fork: false, steer: "future", usage: { tokens: true } }),
  ).toEqual([
    ["Resume", "Yes"],
    ["Fork", "No"],
    ["Mid turn input", "Unknown"],
    ["Concurrent turns", "Unknown"],
    ["Token usage", "Yes"],
    ["Cost reports", "Unknown"],
    ["Context usage", "Unknown"],
    ["Cache reports", "Unknown"],
  ]);
  expect(loginLabel({ state: "api_key_configured" })).toBe("API key configured");
  expect(loginLabel({ state: "future" })).toBe("Login unknown");
  expect(supportLabel("newer")).toBe("Newer than tested");
  expect(supportLabel("future")).toBe("Version support unknown");
});
it("rejects malformed reports rather than presenting an empty successful check", () => {
  expect(() => doctorChecks({})).toThrow("invalid_doctor_report");
  expect(
    doctorChecks({ checks: [null, { kind: "global", id: "disk", state: "unknown" }] }),
  ).toEqual([{ kind: "global", id: "disk", state: "unknown" }]);
});
