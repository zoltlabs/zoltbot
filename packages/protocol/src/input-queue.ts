import { type Static, Type } from "@sinclair/typebox";
import { ArtifactTargetSchema, OutputModeSchema } from "./artifacts.js";
import { At, Id, object, UserInputSchema, values } from "./common.js";
export const QueuedInputBodySchema = object({
  outputMode: Type.Optional(OutputModeSchema),
  artifactTarget: Type.Optional(ArtifactTargetSchema),
  queueVersion: Type.Optional(Type.Literal(1)),
  input: UserInputSchema,
  mode: Type.Optional(values(["queue", "steer"])),
  queueState: values(["queued", "sending", "sent", "handled", "failed", "uncertain"]),
  origin: Type.Optional(values(["human", "agent", "system"])),
  sourceMessageId: Type.Optional(Id),
  sourceInteractionId: Type.Optional(Id),
  sessionId: Type.Optional(Id),
  attemptId: Type.Optional(Id),
  attemptedAt: Type.Optional(At),
  browserGuidance: Type.Optional(object({ bindingId: Id, digest: Id })),
  deliveryMode: Type.Optional(values(["queue", "steer"])),
  errorCode: Type.Optional(
    values([
      "auth_required",
      "provider_unavailable",
      "invalid_input",
      "cancelled",
      "delivery_uncertain",
      "budget_exceeded",
      "native_owner_decision_required",
    ]),
  ),
});
export type QueuedInputBody = Static<typeof QueuedInputBodySchema>;
