import { expect, it } from "vitest";
import { acpError } from "./errors.js";

it("exposes native auth recovery without treating quota and arbitrary errors as sign-out", () => {
  expect(acpError({ code: -32000, message: "Authentication required" }).message).toBe(
    "auth_required",
  );
  const quota = new Error("Quota exceeded");
  expect(acpError(quota)).toBe(quota);
  expect(acpError({ code: -32602, message: "Authentication required" }).message).toBe(
    "provider_request_failed",
  );
});
