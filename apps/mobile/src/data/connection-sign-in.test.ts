import type { Connection } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import {
  addableApps,
  appOf,
  type CatalogApp,
  canSignIn,
  readRedirect,
  signInError,
} from "./connection-sign-in";

const connection = (extra: Partial<Connection> = {}): Connection =>
  ({
    id: "c1",
    name: "Gmail",
    projectId: "p",
    version: 1,
    transport: { kind: "https", url: "https://gmail.example/mcp" },
    schemaTokens: { value: 0, source: "estimated" },
    source: "catalog:gmail:v1",
    enabled: false,
    profileIds: [],
    credentialStatus: "needs_sign_in",
    health: "not_checked",
    ...extra,
  }) as Connection;
const catalog: CatalogApp[] = [
  { id: "gmail", name: "Gmail", description: "", availability: "available", phoneSignIn: true },
  { id: "slack", name: "Slack", description: "", availability: "available", phoneSignIn: true },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "",
    availability: "registration_required",
    phoneSignIn: true,
  },
  { id: "linear", name: "Linear", description: "", availability: "available", phoneSignIn: false },
];

describe("readRedirect", () => {
  it("reads the app redirect", () => {
    expect(
      readRedirect("zoltbot://connection-done?state=s&code=c&iss=https%3A%2F%2Fzoltbot.ai"),
    ).toEqual({ state: "s", code: "c", iss: "https://zoltbot.ai" });
    expect(readRedirect("zoltbot://connection-done?state=s&error=access_denied")).toEqual({
      state: "s",
      error: "access_denied",
    });
  });

  it("ignores other links and repeated values", () => {
    expect(readRedirect("zoltbot://chat?state=s")).toBeUndefined();
    expect(readRedirect("https://connection-done?state=s")).toBeUndefined();
    expect(readRedirect("zoltbot://connection-done?code=c")).toBeUndefined();
    expect(readRedirect("zoltbot://connection-done?state=a&state=b")).toBeUndefined();
    expect(readRedirect("zoltbot://connection-done?state=s&code=a&code=b")).toEqual({
      state: "s",
      code: "",
    });
    expect(readRedirect("zoltbot://connection-done?state=s&code=c&error=a&error=b")).toEqual({
      state: "s",
      code: "c",
      error: "",
    });
    expect(readRedirect("not a url")).toBeUndefined();
  });
});

describe("apps", () => {
  it("knows a connection's app and whether the phone can sign it in", () => {
    expect(appOf(connection())).toBe("gmail");
    expect(appOf(connection({ source: "manual" }))).toBeUndefined();
    expect(canSignIn(connection(), catalog)).toBe(true);
    expect(canSignIn(connection({ source: "catalog:linear:v1" }), catalog)).toBe(false);
    expect(canSignIn(connection({ source: "catalog:hubspot:v1" }), catalog)).toBe(false);
    expect(canSignIn(connection({ credentialStatus: "not_required" }), catalog)).toBe(false);
  });

  it("offers broker apps not added yet", () => {
    expect(addableApps(catalog, [connection()]).map((app) => app.id)).toEqual(["slack"]);
  });

  it("explains failures", () => {
    expect(signInError(new Error("oauth_already_pending"))).toBe(
      "A sign-in for this app is already open.",
    );
    expect(signInError(new Error("boom"))).toBe("Sign-in didn't finish. Try again.");
  });
});
