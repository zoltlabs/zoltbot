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
export const MacApprovalDraftSchema = Type.Omit(MacApprovalPayloadSchema, [
  "signerDeviceId",
  "issuedAt",
  "expiresAt",
]);
export type MacApprovalPayload = Static<typeof MacApprovalPayloadSchema>;
export type SignedMacApproval = Static<typeof SignedMacApprovalSchema>;
export type MacApprovalDraft = Static<typeof MacApprovalDraftSchema>;
export const MacOutputChunkSchema = object({
  requestId: Id,
  taskId: Id,
  chunkSeq: Type.Integer({ minimum: 1 }),
  stream: values(["stdout", "stderr"]),
  data: Type.String({ maxLength: 65536 }),
});
export const MacOutputSnapshotSchema = object({
  requestId: Id,
  taskId: Id,
  state: values(["pending", "running", "complete", "denied"]),
  lastChunkSeq: Type.Integer({ minimum: 0 }),
  stdout: Type.String({ maxLength: 262144 }),
  stderr: Type.String({ maxLength: 65536 }),
  truncated: Type.Boolean(),
  missingChunks: Type.Boolean(),
  exitCode: Type.Optional(Type.Integer()),
});
export type MacOutputChunk = Static<typeof MacOutputChunkSchema>;
export type MacOutputSnapshot = Static<typeof MacOutputSnapshotSchema>;
