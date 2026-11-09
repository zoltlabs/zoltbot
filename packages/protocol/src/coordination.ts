import { type Static, Type } from "@sinclair/typebox";
import { ActorSchema, At, Id, Json, OptionalText, object, Text, values } from "./common.js";

export const MessageSchema = object({
  id: Id,
  thread: Type.Optional(Id),
  /** The exact chat that sent it, so a reply returns there even when chats share a profile. */
  fromThread: Type.Optional(Id),
  task: Type.Optional(Id),
  from: ActorSchema,
  to: Type.Array(ActorSchema, { minItems: 1, maxItems: 32 }),
  kind: values(["message", "task", "result", "review_request", "review_result", "control"]),
  replyTo: Type.Optional(Id),
  expectsReply: Type.Boolean(),
  priority: values(["normal", "urgent"]),
  delivery: values(["next_turn", "steer", "interrupt"]),
  root: Id,
  hops: Type.Integer({ minimum: 0 }),
  ttlHops: Type.Integer({ minimum: 1 }),
  origin: values(["human", "agent"]),
  body: Type.Array(
    Type.Union([
      object({ type: Type.Literal("text"), text: Text }),
      object({ type: Type.Literal("fileRef"), path: Text }),
      object({ type: Type.Literal("data"), value: Json }),
    ]),
  ),
  createdAt: At,
  idempotencyKey: OptionalText,
});
export type Message = Static<typeof MessageSchema>;
export const DeliveryStateSchema = values([
  "queued",
  "held",
  "delivering",
  "delivered",
  "failed",
  "cancelled",
]);
export const DeliverySchema = object({
  id: Id,
  messageId: Id,
  toAgentId: Id,
  queueOrder: Type.Integer({ minimum: 0 }),
  state: DeliveryStateSchema,
  holdReason: OptionalText,
  turnId: Type.Optional(Id),
  deliveredAt: Type.Optional(At),
  error: OptionalText,
});
export type Delivery = Static<typeof DeliverySchema>;
export const GrantSchema = object({
  id: Id,
  holderAgentId: Id,
  capability: values([
    "message",
    "assign",
    "read_summary",
    "read_full",
    "control",
    "spawn",
    "knowledge_write",
    "workspace_shape",
  ]),
  target: Id,
  grantedBy: ActorSchema,
  createdAt: At,
  revokedAt: Type.Optional(At),
});
export type Grant = Static<typeof GrantSchema>;
export const UsageRecordSchema = object({
  id: Id,
  sessionId: Id,
  turnId: Type.Optional(Id),
  taskId: Type.Optional(Id),
  projectId: Type.Optional(Id),
  inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  costKnown: Type.Boolean(),
  injectedTokens: Type.Integer({ minimum: 0 }),
  recordedAt: At,
});

export type UsageRecord = Static<typeof UsageRecordSchema>;
