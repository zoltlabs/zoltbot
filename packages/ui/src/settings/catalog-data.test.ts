import { expect, it } from "vitest";
import {
  connectionError,
  permissionDescription,
  sentrySlugPattern,
  serviceName,
  supportsManagedConnection,
  usesBroker,
} from "./catalog-data.js";

it("identifies only curated sources and verified adapter routes", () => {
  expect(serviceName("catalog:linear:v1")).toBe("Linear");
  expect(serviceName("catalog:sentry:v1")).toBe("Sentry");
  expect(serviceName("manual")).toBeUndefined();
  expect(supportsManagedConnection("claude")).toBe(true);
  expect(supportsManagedConnection("codex")).toBe(true);
  expect(supportsManagedConnection("antigravity")).toBe(false);
});
it("offers safe recovery without rendering provider failure bodies", () => {
  expect(connectionError(new Error("keychain_unavailable"))).toContain("Keychain");
  expect(connectionError(new Error("connection_service_auth_unsupported"))).toContain(
    "requirements changed",
  );
  expect(connectionError(new Error("secret-token-sentinel"))).not.toContain(
    "secret-token-sentinel",
  );
});

it("validates Sentry slugs using the browser v regex mode", () => {
  const pattern = new RegExp(`^(?:${sentrySlugPattern})$`, "v");
  expect(pattern.test("web-app_2")).toBe(true);
  expect(pattern.test("../other")).toBe(false);
  expect(pattern.test(String.raw`web\app`)).toBe(false);
});

it("labels all expanded services and keeps broad grants and broker dependency explicit", () => {
  for (const [id, name] of Object.entries({
    github: "GitHub",
    posthog: "PostHog",
    gmail: "Gmail",
    google_drive: "Google Drive",
    google_docs: "Google Docs",
    slack: "Slack",
  }))
    expect(serviceName(`catalog:${id}:v1`)).toBe(name);
  expect(permissionDescription("github")).toContain("repo scope itself");
  expect(permissionDescription("google_drive")).toContain("not selected-file");
  expect(permissionDescription("gmail")).toContain("No send");
  expect(usesBroker("slack")).toBe(true);
  expect(usesBroker("posthog")).toBe(false);
});
