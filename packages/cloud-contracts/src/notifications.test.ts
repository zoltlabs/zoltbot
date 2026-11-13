import { parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import {
  CloudNotificationSchema,
  CloudPushContextSchema,
  CloudPushRegistrationSchema,
} from "./notifications.js";

const notice = {
  orgId: "org",
  userId: "member",
  taskId: "task:one",
  threadId: "thread:one",
  notificationId: "a".repeat(64),
  kind: "needs_you",
  count: 1,
};
it("limits Cloud notifications to routing identifiers and a bounded fixed kind/count", () => {
  expect(() => parse(CloudNotificationSchema, notice)).not.toThrow();
  for (const name of ["text", "body", "command", "cwd", "stdin", "title", "apiKey", "token"])
    expect(() =>
      parse(CloudNotificationSchema, { ...notice, [name]: "forbidden-content" }),
    ).toThrow();
  for (const change of [
    { count: -1 },
    { count: 10000 },
    { count: 1.5 },
    { kind: "arbitrary-message" },
    { threadId: "Contains private prose" },
    { notificationId: "not-a-digest" },
  ])
    expect(() => parse(CloudNotificationSchema, { ...notice, ...change })).toThrow();
});
it("binds a strict Cloud routing scope without authority to approve commands", () => {
  const context = { kind: "cloud", orgId: "org", notificationId: "a".repeat(64) };
  expect(() => parse(CloudPushContextSchema, context)).not.toThrow();
  for (const extra of [
    { action: "accept" },
    { category: "approval" },
    { deviceId: "other" },
    { signedApproval: {} },
  ])
    expect(() => parse(CloudPushContextSchema, { ...context, ...extra })).toThrow();
});
it("accepts native APNs registration, not a URL or browser push capability", () => {
  const registration = { deviceId: "phone", platform: "apns-sandbox", token: "a".repeat(64) };
  expect(() => parse(CloudPushRegistrationSchema, registration)).not.toThrow();
  for (const change of [
    { platform: "web" },
    { token: "https://example.invalid/receive" },
    { token: "a".repeat(63) },
    { token: "a".repeat(514) },
  ])
    expect(() => parse(CloudPushRegistrationSchema, { ...registration, ...change })).toThrow();
});
