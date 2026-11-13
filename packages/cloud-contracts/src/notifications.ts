import { type Static, Type } from "@sinclair/typebox";
import { object, values } from "@zoltbot/protocol";

const routingId = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]*$",
});
const notificationId = Type.String({ pattern: "^[a-f0-9]{64}$" });
/** Content-free routing only. A notice cannot authorize an action. */
export const CloudPushContextSchema = object({
  kind: Type.Literal("cloud"),
  orgId: routingId,
  notificationId,
});
export type CloudPushContext = Static<typeof CloudPushContextSchema>;
export const CloudPushRegistrationSchema = object({
  deviceId: routingId,
  platform: values(["apns", "apns-sandbox"]),
  token: Type.String({ pattern: "^(?:[a-fA-F0-9]{2}){16,256}$" }),
});
export type CloudPushRegistration = Static<typeof CloudPushRegistrationSchema>;
/** Cell-to-Global request, authenticated separately with the org's service token. */
export const CloudNotificationSchema = object({
  orgId: routingId,
  userId: routingId,
  notificationId,
  taskId: routingId,
  threadId: routingId,
  kind: values(["needs_you", "task_done"]),
  count: Type.Integer({ minimum: 0, maximum: 9999 }),
});
export type CloudNotification = Static<typeof CloudNotificationSchema>;
