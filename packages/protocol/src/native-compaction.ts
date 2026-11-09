import { type Static, Type } from "@sinclair/typebox";
import { Id, object, values } from "./common.js";
export const NativeCompactionBodySchema = object({
  code: Type.Literal("manual_compaction"),
  operationVersion: Type.Literal(1),
  sessionId: Id,
  attemptId: Id,
  expectsEvent: Type.Boolean(),
  state: values(["sending", "acknowledged", "completed", "uncertain"]),
  confirmation: Type.Optional(values(["native_event", "native_ack"])),
  errorCode: Type.Optional(Type.Literal("delivery_uncertain")),
});
export type NativeCompactionBody = Static<typeof NativeCompactionBodySchema>;
