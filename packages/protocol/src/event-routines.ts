import { type Static, Type } from "@sinclair/typebox";
import { At, Id, object, ScopeSchema, values } from "./common.js";

const Short = Type.String({ minLength: 1, maxLength: 200 });
export const EventSourceSchema = object({
  kind: values(["github.ci_failed", "sentry.issue_created", "github.review_requested"]),
  resource: Type.String({
    minLength: 1,
    maxLength: 200,
    pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
  }),
  branch: Type.Optional(Type.String({ maxLength: 200 })),
  workflowId: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  connectionId: Type.Optional(Id),
  reviewTeamId: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
});
export const EventRoutineInputSchema = object({
  name: Type.String({ minLength: 1, maxLength: 150 }),
  brief: Type.String({ minLength: 1, maxLength: 2400 }),
  profileId: Id,
  node: ScopeSchema,
  source: EventSourceSchema,
  dailyLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const EventRoutineConfigSchema = object({
  source: EventSourceSchema,
  commandDigest: Type.Optional(Id),
  revision: Type.Integer({ minimum: 1 }),
  generation: Type.Optional(Type.Integer({ minimum: 1 })),
  sourceMode: Type.Optional(values(["local_poll", "mock"])),
  phase: values(["draft", "saved"]),
  proposedBy: Id,
  chatId: Type.Optional(Id),
  authorizedBy: Type.Optional(Id),
  enabledAt: Type.Optional(At),
  accountId: Type.Optional(Short),
  accountLabel: Type.Optional(Short),
  repositoryId: Type.Optional(Short),
  previewRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  location: Type.Literal("local"),
  dailyLimit: Type.Integer({ minimum: 1, maximum: 100 }),
});
export const RoutineSourceEventSchema = object({
  normalizerVersion: Type.Literal(1),
  digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  key: Short,
  kind: values(["github.ci_failed", "sentry.issue_created", "github.review_requested"]),
  resource: Short,
  accountId: Short,
  resourceId: Short,
  occurredAt: At,
  receivedAt: At,
  sha: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
  baseSha: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
  subjectId: Type.Optional(Short),
  reviewerId: Type.Optional(Short),
  reviewTeamId: Type.Optional(Short),
  category: Type.Optional(Short),
  severity: Type.Optional(Short),
  mock: Type.Optional(Type.Boolean()),
  branch: Type.Optional(Type.String({ maxLength: 200 })),
  workflowId: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  runId: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  attempt: Type.Optional(Type.Integer({ minimum: 1 })),
  superseded: Type.Optional(Type.Boolean()),
  diagnostics: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type EventRoutineInput = Static<typeof EventRoutineInputSchema>;
export type RoutineSourceEvent = Static<typeof RoutineSourceEventSchema>;
