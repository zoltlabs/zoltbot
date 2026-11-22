import { type TSchema, Type } from "@sinclair/typebox";
import {
  At,
  Id,
  Json,
  OptionalText,
  object,
  PermissionProfileSchema,
  ScopeSchema,
  Text,
  values,
} from "./common.js";
import { EventRoutineInputSchema } from "./event-routines.js";
import {
  ContextPackSchema,
  KnowledgeItemSchema,
  PipelineVersionSchema,
  RoutineOccurrenceSchema,
  RoutineScheduleSchema,
  RoutineSchema,
  RoutineTemplateSchema,
  WorkflowRunSchema,
} from "./knowledge-workflows.js";

const idParams = object({ id: Id });
const page = object({
  cursor: OptionalText,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  projectId: Type.Optional(Id),
  agentId: Type.Optional(Id),
});
const ok = object({ ok: Type.Boolean() });
const entry = <P extends TSchema, R extends TSchema>(params: P, result: R) => ({ params, result });
const list = (schema: TSchema) =>
  entry(page, object({ items: Type.Array(schema), cursor: OptionalText }));
export const knowledgeWorkflowMethods = {
  "knowledge.list": entry(
    object({
      ...page.properties,
      scope: Type.Optional(ScopeSchema),
      query: Type.Optional(Type.String({ maxLength: 500 })),
      kind: OptionalText,
      status: OptionalText,
    }),
    object({ items: Type.Array(KnowledgeItemSchema), cursor: OptionalText }),
  ),
  "knowledge.preview": entry(
    object({
      scope: ScopeSchema,
      query: Type.String({ maxLength: 4000 }),
      remainingTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 1500 })),
    }),
    Json,
  ),
  "knowledge.sendUpdate": entry(
    object({
      taskId: Id,
      ids: Type.Array(Id, { minItems: 1, maxItems: 10 }),
      confirmed: Type.Boolean(),
    }),
    ok,
  ),
  "knowledge.promoteDraft": entry(
    object({
      taskId: Id,
      itemId: Type.Optional(Id),
      selectedText: Type.Optional(Type.String({ minLength: 1, maxLength: 1200 })),
    }),
    KnowledgeItemSchema,
  ),
  "knowledge.exclude": entry(
    object({ taskId: Id, ids: Type.Array(Id, { maxItems: 200 }), confirmed: Type.Boolean() }),
    ok,
  ),
  "knowledge.get": entry(idParams, KnowledgeItemSchema),
  "knowledge.upsert": entry(
    object({ value: KnowledgeItemSchema, expectedRevision: Type.Integer({ minimum: 0 }) }),
    KnowledgeItemSchema,
  ),
  "knowledge.archive": entry(
    object({ id: Id, expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })) }),
    ok,
  ),
  "knowledge.revisions": entry(idParams, Type.Array(KnowledgeItemSchema)),
  "contextPack.get": entry(
    object({ taskId: Id, revision: Type.Integer({ minimum: 1 }) }),
    ContextPackSchema,
  ),
  "inspector.get": entry(
    object({ taskId: Id }),
    object({
      pack: Type.Optional(ContextPackSchema),
      reads: Type.Array(Json),
      injectedTokens: Type.Integer({ minimum: 0 }),
    }),
  ),
  "workflow.list": list(PipelineVersionSchema),
  "workflow.draftFromTask": entry(object({ taskId: Id }), PipelineVersionSchema),
  "workflow.publish": entry(
    object({
      value: PipelineVersionSchema,
      confirmed: Type.Boolean(),
      /** The version the edit started from; publishing refuses if a newer one landed since. */
      baseVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    PipelineVersionSchema,
  ),
  "workflow.run": entry(
    object({
      id: Id,
      inputs: Json,
      dryRun: Type.Optional(Type.Boolean()),
      profileOverrides: Type.Optional(Type.Record(Id, Id)),
    }),
    WorkflowRunSchema,
  ),
  "workflow.pause": entry(idParams, ok),
  /** R7: start new steps again in a paused workflow's runs. */
  "workflow.resume": entry(idParams, ok),
  /** R7: answer a run's "wait for my approval" step. */
  "workflow.decide": entry(
    object({ id: Id, stepId: Id, decision: values(["continue", "stop"]) }),
    WorkflowRunSchema,
  ),
  "workflow.runs": list(WorkflowRunSchema),
  "routine.list": list(RoutineSchema),
  /** R3: starts a scheduled routine now, without moving its schedule. */
  "routine.runNow": entry(object({ id: Id }), RoutineOccurrenceSchema),
  "routine.checkSource": entry(object({ id: Id, revision: Type.Integer() }), RoutineSchema),
  // R2: a web-address routine's address, made if missing; `rotate` replaces it.
  "routine.webhookAddress": entry(
    object({ id: Id, rotate: Type.Optional(Type.Boolean()) }),
    Type.Union([
      object({ state: Type.Literal("ready"), url: Type.String({ maxLength: 2048 }) }),
      object({ state: Type.Literal("elsewhere") }),
    ]),
  ),
  "routine.webhookTest": entry(object({ id: Id }), object({ ok: Type.Literal(true) })),
  "routine.connectionHandoff": entry(object({ id: Id, revision: Type.Integer() }), Json),
  "routine.prepare": entry(EventRoutineInputSchema, RoutineSchema),
  "routine.editEvent": entry(
    object({ id: Id, revision: Type.Integer(), input: EventRoutineInputSchema }),
    RoutineSchema,
  ),
  "routine.preview": entry(object({ id: Id, revision: Type.Integer() }), Json),
  "routine.commit": entry(object({ id: Id, revision: Type.Integer() }), RoutineSchema),
  "routine.enable": entry(object({ id: Id, revision: Type.Integer() }), RoutineSchema),
  "routine.runOnce": entry(object({ id: Id, revision: Type.Integer(), occurrenceId: Id }), Json),
  "routine.retrySource": entry(object({ id: Id, revision: Type.Integer() }), Json),
  "routine.archiveHistory": entry(object({ id: Id, revision: Type.Integer(), before: At }), Json),
  "routine.pause": entry(object({ id: Id, revision: Type.Integer() }), RoutineSchema),
  "routine.create": entry(
    object({
      taskId: Id,
      name: Text,
      schedule: RoutineScheduleSchema,
      permissionCeiling: Type.Optional(PermissionProfileSchema),
      notify: values(["always", "actionable_only"]),
    }),
    RoutineSchema,
  ),
  /** D5: first jobs that fit the apps the owner connected, offered at the end of setup. */
  "routine.starters": list(object({ id: Id, name: Text, projectId: Id })),
  /** D5: saves a starter job as a paused routine; the owner turns it on from Routines. */
  "routine.createStarter": entry(
    object({ jobId: Id, profileId: Id, timezone: Text }),
    RoutineSchema,
  ),
  "routine.update": entry(
    object({
      id: Id,
      expectedUpdatedAt: At,
      schedule: Type.Optional(RoutineScheduleSchema),
      template: Type.Optional(RoutineTemplateSchema),
      notify: Type.Optional(values(["always", "actionable_only"])),
      paused: Type.Optional(Type.Boolean()),
      permissionCeiling: Type.Optional(PermissionProfileSchema),
    }),
    RoutineSchema,
  ),
  "routine.history": entry(
    object({ id: Id }),
    object({ items: Type.Array(RoutineOccurrenceSchema) }),
  ),
};
