import { type Static, Type } from "@sinclair/typebox";
import { BrowserSelectionSchema } from "./browser.js";
import {
  ActorSchema,
  At,
  Id,
  Json,
  OptionalText,
  object,
  PermissionProfileSchema,
  ScopeSchema,
  Strings,
  Text,
  values,
} from "./common.js";
import { EventRoutineConfigSchema, RoutineSourceEventSchema } from "./event-routines.js";

export const SourceRefSchema = object({
  kind: values(["task", "thread", "file", "url", "deliverable"]),
  ref: Text,
  label: OptionalText,
  taskRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  sessionId: Type.Optional(Id),
  turnId: Type.Optional(Id),
  itemId: Type.Optional(Id),
  sourceText: Type.Optional(Type.String({ maxLength: 16000 })),
  sourceReviewState: OptionalText,
});
export const KnowledgeItemSchema = object({
  id: Id,
  scope: ScopeSchema,
  kind: values([
    "goal",
    "decision",
    "constraint",
    "requirement",
    "preference",
    "lesson",
    "open_question",
    "artifact_ref",
    "glossary",
  ]),
  key: OptionalText,
  title: Text,
  body: Type.String({ maxLength: 1200 }),
  tags: Strings,
  owner: ActorSchema,
  /** human: written or accepted by a person; unverified: applied by an agent; confirmed later. */
  verification: values(["human", "unverified", "confirmed"]),
  /** Who wrote the current revision; may differ from the accountable owner. */
  writer: ActorSchema,
  status: values(["active", "stale", "superseded", "archived"]),
  sources: Type.Array(SourceRefSchema),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: At,
  updatedAt: At,
  lastVerifiedAt: Type.Optional(At),
  reviewBy: Type.Optional(At),
  supersedes: Type.Optional(Id),
  pinned: Type.Optional(Type.Boolean()),
});
export type KnowledgeItem = Static<typeof KnowledgeItemSchema>;
export const ContextPackSchema = object({
  id: Id,
  /** Task runs carry the task; chats, chief of staff and pipeline stages carry the thread. */
  taskId: Type.Optional(Id),
  threadId: Type.Optional(Id),
  revision: Type.Integer({ minimum: 1 }),
  included: Type.Array(
    object({
      id: Id,
      revision: Type.Integer({ minimum: 1 }),
      text: Text,
      tokens: Type.Integer({ minimum: 0 }),
    }),
  ),
  excluded: Type.Array(
    object({
      id: Id,
      reason: values([
        "over_budget",
        "user_budget",
        "low_score",
        "stale",
        "overridden",
        "excluded",
      ]),
    }),
  ),
  tokenEstimate: Type.Integer({ minimum: 0, maximum: 1500 }),
  createdAt: At,
});
export type ContextPack = Static<typeof ContextPackSchema>;

export const DeliverableKindSchema = values([
  "report",
  "document",
  "spreadsheet",
  "site",
  "code_change",
  "design",
  "other",
]);
export const EvidenceSchema = object({
  kind: Text,
  label: Text,
  ref: Text,
  status: values(["passed", "failed", "partial", "none"]),
  required: Type.Optional(Type.Boolean()),
});
export const DeliverableSchema = object({
  id: Id,
  taskId: Id,
  initiativeId: Type.Optional(Id),
  projectId: Type.Optional(Id),
  kind: DeliverableKindSchema,
  title: Text,
  version: Type.Integer({ minimum: 1 }),
  supersedes: Type.Optional(Id),
  ref: Text,
  evidence: Type.Array(EvidenceSchema),
  validationState: values(["none", "passed", "failed", "partial"]),
  reviewState: values(["pending", "accepted", "changes_requested", "rejected"]),
  createdAt: At,
});
export const CheckSchema = object({
  name: Text,
  command: OptionalText,
  path: OptionalText,
  assertion: Type.Optional(values(["exists", "non_empty", "schema"])),
  schema: Type.Optional(Json),
  expectedExitCode: Type.Optional(Type.Integer()),
  required: Type.Boolean(),
});
export const BudgetSchema = object({
  usd: Type.Optional(Type.Number({ minimum: 0 })),
  tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  wallClockMinutes: Type.Optional(Type.Number({ minimum: 0 })),
});
export const RetryPolicySchema = object({
  maxAttempts: Type.Integer({ minimum: 1 }),
  backoffSeconds: Type.Array(Type.Number({ minimum: 0 })),
  retryOn: Strings,
  maxCostUsdPerTask: Type.Optional(Type.Number({ minimum: 0 })),
  maxCostUsdPerDay: Type.Optional(Type.Number({ minimum: 0 })),
});
export const StageSchema = object({
  id: Id,
  name: Text,
  profileId: Id,
  instruction: Text,
  inputs: Type.Array(
    object({
      from: Id,
      kind: Type.Optional(values(["brief", "knowledge", "deliverable", "files"])),
    }),
  ),
  output: object({ kind: DeliverableKindSchema, title: Text }),
  workspace: values(["none", "shared", "worktree"]),
  checks: Type.Array(CheckSchema),
  gate: values(["human", "auto_if_checks_pass", "none"]),
  budget: Type.Optional(BudgetSchema),
});
export const PipelineVersionSchema = object({
  workflowId: Id,
  version: Type.Integer({ minimum: 1 }),
  name: Text,
  description: Text,
  scope: ScopeSchema,
  inputs: Json,
  briefTemplate: Text,
  acceptance: Text,
  expectedDeliverable: object({ kind: DeliverableKindSchema, title: Text }),
  checks: Type.Array(CheckSchema),
  permissionProfile: PermissionProfileSchema,
  executorAgent: Id,
  workspaceMode: values(["shared", "worktree"]),
  budget: BudgetSchema,
  retry: RetryPolicySchema,
  review: values(["required", "on_failure", "none"]),
  notify: values(["always", "on_change", "on_failure"]),
  trigger: Type.Array(
    object({ kind: values(["manual", "schedule"]), cron: OptionalText, timezone: OptionalText }),
  ),
  overlap: values(["skip", "queue", "replace"]),
  previousResult: values(["none", "summary", "deliverable_ref"]),
  stages: Type.Array(StageSchema),
  loops: Type.Array(
    object({
      from: Id,
      to: Id,
      when: Type.Literal("findings_open"),
      maxRounds: Type.Integer({ minimum: 1 }),
    }),
  ),
});
export type PipelineVersion = Static<typeof PipelineVersionSchema>;
export const RoutineScheduleSchema = object({
  // Five-field daily/weekly cron, or @every <minutes>m.
  cron: Text,
  timezone: Text,
});
export const RoutineInputsSchema = object({
  browser: Type.Optional(BrowserSelectionSchema),
  knowledge: Type.Union([Type.Literal("inherit"), Strings]),
  skills: Type.Union([Type.Literal("inherit"), Strings]),
  connections: Type.Union([Type.Literal("inherit"), Strings]),
});
export const RoutineTemplateSchema = object({
  title: Type.String({ minLength: 1, maxLength: 150 }),
  brief: Type.String({ minLength: 1, maxLength: 4000 }),
  acceptance: Type.String({ maxLength: 2000 }),
  profileId: Id,
  node: ScopeSchema,
  workspaceId: Type.Optional(Id),
  inputs: RoutineInputsSchema,
});
export const RoutineSchema = object({
  event: Type.Optional(EventRoutineConfigSchema),
  id: Id,
  name: Text,
  schedule: RoutineScheduleSchema,
  template: RoutineTemplateSchema,
  permissionCeiling: PermissionProfileSchema,
  notify: values(["always", "actionable_only"]),
  paused: Type.Boolean(),
  nextRunAt: At,
  createdAt: At,
  updatedAt: At,
});
export type Routine = Static<typeof RoutineSchema>;
export const RoutineOccurrenceSchema = object({
  manual: Type.Optional(Type.Boolean()),
  generation: Type.Optional(Type.Integer({ minimum: 1 })),
  replayOf: Type.Optional(Id),
  archivedAt: Type.Optional(At),
  expiresAt: Type.Optional(At),
  duplicates: Type.Optional(Type.Integer({ minimum: 0 })),
  lastObservedAt: Type.Optional(At),
  eventMeta: Type.Optional(object({ key: Id, digest: Id, kind: Text })),
  frozenRoutine: Type.Optional(RoutineSchema),
  sourceEvent: Type.Optional(RoutineSourceEventSchema),
  routineRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  frozenBrief: Type.Optional(Type.String({ maxLength: 4000 })),
  id: Id,
  routineId: Id,
  scheduledAt: At,
  taskId: Type.Optional(Id),
  status: values([
    "waiting",
    "quarantined",
    "queued",
    "started",
    "skipped",
    "missed",
    "expired",
    "completed",
  ]),
  outcome: Type.Optional(values(["nothing", "actionable", "needs_you"])),
  notify: values(["always", "actionable_only"]),
  reason: OptionalText,
  permissionDeadline: Type.Optional(At),
  createdAt: At,
  updatedAt: At,
});
export type RoutineOccurrence = Static<typeof RoutineOccurrenceSchema>;
export const WorkflowRunSchema = object({
  id: Id,
  workflowId: Id,
  version: Type.Integer({ minimum: 1 }),
  taskId: Type.Optional(Id),
  trigger: Text,
  inputs: Json,
  state: values(["scheduled", "running", "at_gate", "looping", "completed", "failed", "cancelled"]),
  resultHash: OptionalText,
  startedAt: Type.Optional(At),
  endedAt: Type.Optional(At),
});
