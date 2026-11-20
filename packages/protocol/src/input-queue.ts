import { type Static, Type } from "@sinclair/typebox";
import { ArtifactTargetSchema, OutputModeSchema } from "./artifacts.js";
import { At, Id, object, UserInputSchema, values } from "./common.js";
/**
 * What a daemon-written input is, so clients can show it as a notice line without parsing its
 * text: a message from another chat, a work supervision notice, or the end of a team wait.
 */
export const InputNoticeSchema = object({
  kind: values(["team", "supervision", "wait"]),
  type: Type.Optional(values(["brief", "question", "update", "reply", "report"])),
  messageId: Type.Optional(Id),
  fromThreadId: Type.Optional(Id),
  /** The channel a team message was posted in. */
  channelId: Type.Optional(Id),
  taskId: Type.Optional(Id),
  state: Type.Optional(Id),
  waitId: Type.Optional(Id),
  preview: Type.Optional(Type.String({ maxLength: 300 })),
});
export type InputNotice = Static<typeof InputNoticeSchema>;
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
  notice: Type.Optional(InputNoticeSchema),
  sessionId: Type.Optional(Id),
  attemptId: Type.Optional(Id),
  attemptedAt: Type.Optional(At),
  browserGuidance: Type.Optional(object({ bindingId: Id, digest: Id })),
  deliveryMode: Type.Optional(values(["queue", "steer"])),
  /** Set when the owner reorders the queue; queued items without one sort by `seq`. */
  queuePosition: Type.Optional(Type.Number()),
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

/** Where a user item stands in its thread's queue: the owner's order first, then arrival. */
export function queueOrderKey(item: { seq?: unknown; body?: unknown }): number {
  const position = (item.body as { queuePosition?: unknown } | undefined)?.queuePosition;
  return typeof position === "number" && Number.isFinite(position) ? position : Number(item.seq);
}
