import { expect, it } from "vitest";
import { redirectSystemPath } from "../app/+native-intent.js";

it("leaves the native sign-in handoff to the system auth session", () => {
  expect(
    redirectSystemPath({ path: "zoltbot://account/callback?code=fixture&state=fixture" }),
  ).toBeNull();
  expect(redirectSystemPath({ path: "/account/callback?code=fixture&state=fixture" })).toBeNull();
  expect(redirectSystemPath({ path: "account/callback?code=fixture&state=fixture" })).toBeNull();
});

it("preserves existing pair and share routes", () => {
  for (const path of ["zoltbot://pair?fixture=1", "zoltbot://shared/fixture", "/cloud-account"])
    expect(redirectSystemPath({ path })).toBe(path);
});
