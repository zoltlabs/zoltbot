import { type Static, Type } from "@sinclair/typebox";
import { Id, object, values } from "./common.js";

/** Wire shape only; signature, current authority, expiry and replay checks belong to the Mac. */
export const MacApprovalPayloadSchema = object({
  v: Type.Literal(1),
  orgId: Id,
  userId: Id,
  signerDeviceId: Id,
  requestId: Id,
  taskId: Id,
  turnId: Id,
  targetDeviceId: Id,
  scope: values(["command", "prefix"]),
  command: Type.String({ minLength: 1, maxLength: 16000 }),
  cwd: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
  stdinHash: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  issuedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  expiresAt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export const SignedMacApprovalSchema = object({
  payload: MacApprovalPayloadSchema,
  signature: Type.String({ pattern: "^[A-Za-z0-9_-]{86}$" }),
});
export type MacApprovalPayload = Static<typeof MacApprovalPayloadSchema>;
export type SignedMacApproval = Static<typeof SignedMacApprovalSchema>;
