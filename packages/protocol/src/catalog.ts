import { type TSchema, Type } from "@sinclair/typebox";
import { AgentEventSchema } from "./adapter-events.js";
import {
  ArtifactCommentSchema,
  ArtifactSchema,
  ArtifactTargetSchema,
  ArtifactVersionSchema,
  artifactMethods,
  OutputModeSchema,
} from "./artifacts.js";
import { BrowserSelectionSchema, browserMacOnlyMethods, browserMethods } from "./browser.js";
import {
  At,
  Id,
  Json,
  OptionalText,
  object,
  PermissionProfileSchema,
  ScopeSchema,
  Strings,
  Text,
  UserInputSchema,
  values,
} from "./common.js";
import { CompareMemberSchema, CompareSchema, compareMethods } from "./compare.js";
import { connectionMethods } from "./connections.js";
import { DeliverySchema, GrantSchema, MessageSchema, UsageRecordSchema } from "./coordination.js";
import {
  AgentDefinitionSchema,
  AuditSchema,
  DeviceSchema,
  ItemSchema,
  NativeSessionSchema,
  ProfileSchema,
  ProjectSchema,
  SessionSchema,
  SettingSchema,
  SubprojectSchema,
  TaskResultSchema,
  TaskSchema,
  ThreadSchema,
  TurnSchema,
  WorkspaceSchema,
} from "./entities.js";
import { EventRoutineInputSchema } from "./event-routines.js";
import { ForkBoundarySchema, ForkKindSchema, ForkOperationSchema } from "./forks.js";
import { inboxMethods } from "./inbox.js";
import {
  ApprovalRuleSchema,
  InteractionSchema,
  ResolutionSchema,
  RuleDraftSchema,
} from "./interactions.js";
import {
  ContextPackSchema,
  DeliverableSchema,
  KnowledgeItemSchema,
  PipelineVersionSchema,
  RoutineOccurrenceSchema,
  RoutineScheduleSchema,
  RoutineSchema,
  RoutineTemplateSchema,
  WorkflowRunSchema,
} from "./knowledge-workflows.js";
import { KnowledgeProposalSchema, knowledgeWriteMethods } from "./knowledge-writes.js";
import { OrchestrationSchema, orchestrationMethods } from "./orchestration.js";
import { quickChatEvents, quickChatMacOnlyMethods, quickChatMethods } from "./quick-chat.js";
import {
  ShippingFeedbackSchema,
  ShippingOperationSchema,
  ShippingSchema,
  shippingMacOnlyMethods,
  shippingMethods,
} from "./shipping.js";
import { skillMacOnlyMethods, skillMethods } from "./skills.js";
import { terminalMethods } from "./terminal.js";

import { WakeSchema, wakeMethods } from "./wakes.js";

export const entitySchemas = {
  wake: WakeSchema,
  compare: CompareSchema,
  compareMember: CompareMemberSchema,
  orchestration: OrchestrationSchema,
  shipping: ShippingSchema,
  shippingOperation: ShippingOperationSchema,
  shippingFeedback: ShippingFeedbackSchema,
  artifact: ArtifactSchema,
  artifactVersion: ArtifactVersionSchema,
  artifactComment: ArtifactCommentSchema,
  agent: ProfileSchema,
  agentDefinition: AgentDefinitionSchema,
  project: ProjectSchema,
  subproject: SubprojectSchema,
  area: SubprojectSchema,
  initiative: SubprojectSchema,
  thread: ThreadSchema,
  session: SessionSchema,
  turn: TurnSchema,
  item: ItemSchema,
  interaction: InteractionSchema,
  rule: ApprovalRuleSchema,
  message: MessageSchema,
  delivery: DeliverySchema,
  grant: GrantSchema,
  task: TaskSchema,
  taskResult: TaskResultSchema,
  workspace: WorkspaceSchema,
  nativeSession: NativeSessionSchema,
  usage: UsageRecordSchema,
  audit: AuditSchema,
  settings: SettingSchema,
  device: DeviceSchema,
  knowledge: KnowledgeItemSchema,
  contextPack: ContextPackSchema,
  knowledgeProposal: KnowledgeProposalSchema,
  deliverable: DeliverableSchema,
  workflow: PipelineVersionSchema,
  workflowRun: WorkflowRunSchema,
  routine: RoutineSchema,
  routineOccurrence: RoutineOccurrenceSchema,
};
export type EntityKind = keyof typeof entitySchemas;
const empty = object({});
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
const crud = <T extends TSchema>(schema: T) => ({
  list: list(schema),
  create: entry(object({ value: schema }), schema),
  update: entry(
    object({
      id: Id,
      version: Type.Optional(Type.Integer({ minimum: 1 })),
      changes: Type.Partial(schema),
    }),
    schema,
  ),
  archive: entry(object({ id: Id, confirmed: Type.Boolean() }), ok),
});
const agent = crud(ProfileSchema),
  thread = crud(ThreadSchema),
  project = crud(ProjectSchema),
  area = crud(SubprojectSchema),
  initiative = crud(SubprojectSchema),
  subproject = crud(SubprojectSchema),
  task = crud(TaskSchema);

export const methodCatalog = {
  ...wakeMethods,
  ...terminalMethods,
  ...inboxMethods,
  ...compareMethods,
  ...shippingMethods,
  ...artifactMethods,
  ...skillMethods,
  ...connectionMethods,
  ...orchestrationMethods,
  ...knowledgeWriteMethods,
  ...quickChatMethods,
  hello: entry(
    object({ protocolVersion: Type.Integer({ minimum: 1 }), token: Text }),
    object({ protocolVersion: Type.Integer(), version: Text }),
  ),
  "snapshot.get": entry(
    empty,
    object({
      seq: Type.Integer({ minimum: 0 }),
      entities: Type.Record(Text, Type.Array(Json)),
      counters: Type.Record(Text, Type.Integer({ minimum: 0 })),
    }),
  ),
  "events.subscribe": entry(
    object({ fromSeq: Type.Optional(Type.Integer({ minimum: 0 })) }),
    object({ seq: Type.Integer({ minimum: 0 }), resync: Type.Boolean(), events: Type.Array(Json) }),
  ),
  "events.unsubscribe": entry(empty, ok),
  "detect.scan": entry(object({ paths: Type.Optional(Strings) }), Type.Array(Json)),
  "detect.checkLogin": entry(
    object({ definitionId: Id }),
    object({ state: values(["signed_in", "signed_out", "unknown", "api_key_configured"]) }),
  ),
  "detect.startLogin": entry(object({ definitionId: Id }), object({ processId: Id })),
  "import.preview": entry(
    object({ sources: Strings, consent: Type.Boolean(), codeFolders: Type.Optional(Strings) }),
    object({ previewId: Id, items: Type.Array(Json) }),
  ),
  "import.apply": entry(object({ previewId: Id, selected: Strings, consent: Type.Boolean() }), ok),
  "doctor.report": entry(empty, object({ checks: Type.Array(Json) })),
  "doctor.fix": entry(object({ definitionId: Id, action: Id, confirmed: Type.Boolean() }), ok),
  "update.list": entry(empty, object({ updates: Type.Array(Json) })),
  "update.run": entry(
    object({ definitionId: Id, confirmed: Type.Boolean() }),
    object({ version: OptionalText }),
  ),
  "agent.list": agent.list,
  "agent.create": agent.create,
  "agent.update": agent.update,
  "agent.archive": agent.archive,
  "agent.duplicate": entry(object({ id: Id, name: Text }), ProfileSchema),
  "agentDefinition.list": list(AgentDefinitionSchema),
  "agentDefinition.upsert": entry(object({ value: AgentDefinitionSchema }), AgentDefinitionSchema),
  "agentDefinition.probe": entry(
    object({ command: Text, args: Strings }),
    object({ definition: Type.Optional(AgentDefinitionSchema), error: OptionalText }),
  ),
  "thread.list": thread.list,
  "thread.create": entry(
    object({ value: ThreadSchema, confirmed: Type.Optional(Type.Boolean()) }),
    ThreadSchema,
  ),
  "thread.rename": entry(object({ id: Id, title: Text }), ThreadSchema),
  "thread.archive": thread.archive,
  "thread.fork": entry(
    object({
      id: Id,
      title: Type.Optional(Text),
      boundary: Type.Optional(ForkBoundarySchema),
      destinationProfileId: Type.Optional(Id),
      kind: Type.Optional(ForkKindSchema),
    }),
    ForkOperationSchema,
  ),
  "thread.forkPreview": entry(
    object({
      id: Id,
      boundary: Type.Optional(ForkBoundarySchema),
      destinationProfileId: Type.Optional(Id),
      kind: Type.Optional(ForkKindSchema),
    }),
    Json,
  ),
  "thread.forkGet": entry(object({ id: Id }), ForkOperationSchema),
  "thread.forkHistory": entry(object({ id: Id }), object({ items: Type.Array(ItemSchema) })),
  "thread.history": entry(
    object({
      threadId: Id,
      cursor: OptionalText,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    object({ items: Type.Array(ItemSchema), cursor: OptionalText }),
  ),
  "thread.search": entry(
    object({ query: Text, threadId: Type.Optional(Id), cursor: OptionalText }),
    object({ items: Type.Array(ItemSchema), cursor: OptionalText }),
  ),
  "turn.send": entry(
    object({
      threadId: Id,
      input: UserInputSchema,
      mode: values(["queue", "steer"]),
      outputMode: Type.Optional(OutputModeSchema),
      artifactTarget: Type.Optional(ArtifactTargetSchema),
    }),
    object({ id: Id, disposition: values(["started", "queued", "handled"]) }),
  ),
  "turn.cancelQueued": entry(object({ threadId: Id, id: Id }), ok),
  "turn.interrupt": entry(object({ threadId: Id, turnId: Id }), ok),
  "turn.retry": entry(object({ threadId: Id }), ok),
  "session.compact": entry(object({ id: Id, instructions: OptionalText }), ok),
  "session.connect": entry(object({ threadId: Id, previousSessionId: Type.Optional(Id) }), ok),
  "session.setModel": entry(
    object({ id: Id, model: Text, effort: OptionalText, cacheWarningAccepted: Type.Boolean() }),
    ok,
  ),
  "session.setEffort": entry(
    object({ id: Id, effort: Text, cacheWarningAccepted: Type.Boolean() }),
    ok,
  ),
  "session.setMode": entry(
    object({ id: Id, mode: Text, confirmed: Type.Optional(Type.Boolean()) }),
    ok,
  ),
  "session.stopBackground": entry(object({ id: Id, taskId: Id }), ok),
  /** I13: restoring files discards work, so a real run needs confirmed: true and is audited. */
  "session.rewind": entry(
    object({ id: Id, turnId: Id, dryRun: Type.Boolean(), confirmed: Type.Boolean() }),
    object({
      canRewind: Type.Boolean(),
      files: Strings,
      insertions: Type.Optional(Type.Integer({ minimum: 0 })),
      deletions: Type.Optional(Type.Integer({ minimum: 0 })),
      error: OptionalText,
    }),
  ),
  "provider.loginInfo": entry(
    object({ profileId: Id }),
    object({ provider: Text, command: Text, configDirectory: Text }),
  ),
  "native.list": list(NativeSessionSchema),
  "native.adopt": entry(object({ provider: Id, nativeId: Id, profileId: Id }), ThreadSchema),
  "native.reconcile": entry(empty, ok),
  "native.openCommand": entry(object({ provider: Id, nativeId: Id }), object({ command: Text })),
  "interaction.list": list(InteractionSchema),
  "interaction.answer": entry(
    object({ id: Id, version: Type.Integer({ minimum: 1 }), answer: ResolutionSchema }),
    InteractionSchema,
  ),
  "interaction.defer": entry(idParams, ok),
  "interaction.forwardLate": entry(
    object({
      id: Id,
      version: Type.Integer({ minimum: 1 }),
      text: Text,
      confirmed: Type.Literal(true),
    }),
    object({ id: Id, disposition: Type.Literal("queued") }),
  ),
  "interaction.batchAnswer": entry(
    object({
      items: Type.Array(
        object({ id: Id, version: Type.Integer({ minimum: 1 }), answer: ResolutionSchema }),
        { minItems: 1, maxItems: 100 },
      ),
    }),
    object({ results: Type.Array(Json) }),
  ),
  "rule.list": entry(
    object({
      ...page.properties,
      scope: Type.Optional(RuleDraftSchema.properties.scope),
      state: Type.Optional(values(["active", "inactive", "all"])),
    }),
    object({ items: Type.Array(ApprovalRuleSchema), cursor: OptionalText }),
  ),
  "rule.test": entry(
    object({
      command: Type.String({ minLength: 1, maxLength: 16000 }),
      tool: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      agentId: Type.Optional(Id),
      projectId: Type.Optional(Id),
    }),
    object({
      decision: values(["allow", "deny", "ask"]),
      ruleId: Type.Optional(Id),
      reason: values(["matched", "no_rule", "unsupported_command"]),
      destructive: Type.Boolean(),
    }),
  ),
  "rule.create": entry(
    object({ rule: RuleDraftSchema, confirmed: Type.Boolean() }),
    ApprovalRuleSchema,
  ),
  "rule.revoke": entry(idParams, ok),
  "message.send": entry(
    object({ message: MessageSchema }),
    object({ messageId: Id, deliveries: Type.Array(DeliverySchema) }),
  ),
  "message.list": list(MessageSchema),
  "grant.list": list(GrantSchema),
  "grant.set": entry(object({ grant: GrantSchema, confirmed: Type.Boolean() }), GrantSchema),
  "audit.list": list(AuditSchema),
  "team.killSwitch": entry(
    object({ confirmed: Type.Boolean(), focusThreadId: Type.Optional(Id) }),
    ok,
  ),
  "project.list": project.list,
  "project.create": project.create,
  "project.update": project.update,
  "project.files.detect": entry(
    idParams,
    object({
      instructions: Strings,
      design: Type.Array(object({ path: Text, kind: values(["guide", "tokens"]) })),
    }),
  ),
  "project.archive": project.archive,
  "subproject.list": subproject.list,
  "subproject.create": subproject.create,
  "subproject.update": subproject.update,
  "subproject.archive": subproject.archive,
  "area.list": area.list,
  "area.create": area.create,
  "area.update": area.update,
  "area.archive": area.archive,
  "initiative.list": initiative.list,
  "initiative.create": initiative.create,
  "initiative.update": initiative.update,
  "initiative.archive": initiative.archive,
  "assignment.set": entry(
    object({
      projectId: Id,
      profileId: Id,
      role: Type.Literal("chief_of_staff"),
      confirmed: Type.Boolean(),
    }),
    ok,
  ),
  "assignment.end": entry(object({ projectId: Id, confirmed: Type.Boolean() }), ok),
  "routing.rules.list": list(Json),
  "routing.rules.set": entry(object({ projectId: Id, rules: Type.Array(Json) }), ok),
  "limits.get": entry(object({ scopeType: Id, scopeId: Id }), Type.Record(Text, Type.Number())),
  "limits.set": entry(
    object({
      scopeType: Id,
      scopeId: Id,
      limits: Type.Record(Text, Type.Number()),
      confirmed: Type.Boolean(),
    }),
    ok,
  ),
  "task.list": task.list,
  ...browserMethods,
  "task.create": entry(
    object({
      outputMode: Type.Optional(OutputModeSchema),
      title: Type.String({ minLength: 1, maxLength: 150 }),
      brief: Type.String({ minLength: 1, maxLength: 4000 }),
      acceptance: Type.Optional(Type.String({ maxLength: 2000 })),
      profileId: Id,
      node: ScopeSchema,
      workspaceMode: Type.Optional(values(["shared", "worktree"])),
      baseRef: OptionalText,
      browser: Type.Optional(BrowserSelectionSchema),
    }),
    TaskSchema,
  ),
  "task.prepareWorkspace": entry(idParams, TaskSchema),
  "task.changes": entry(idParams, Json),
  "task.reviewCommitPreview": entry(idParams, Json),
  "task.reviewCommit": entry(
    object({ id: Id, fingerprint: Text, message: OptionalText, confirmed: Type.Boolean() }),
    Json,
  ),
  "task.integrationPreview": entry(idParams, Json),
  "task.archiveWorkspace": entry(object({ id: Id, confirmed: Type.Boolean() }), Json),
  "task.restoreWorkspace": entry(object({ id: Id, confirmed: Type.Boolean() }), Json),
  "task.integrate": entry(object({ id: Id, fingerprint: Text, confirmed: Type.Boolean() }), Json),
  "task.update": task.update,
  "task.cancel": entry(object({ id: Id, confirmed: Type.Boolean() }), TaskSchema),
  "task.retry": entry(idParams, TaskSchema),
  "task.review": entry(
    object({
      id: Id,
      revision: Type.Integer({ minimum: 1 }),
      decision: values(["accept", "changes", "reject"]),
      feedback: OptionalText,
      confirmed: Type.Boolean(),
    }),
    TaskSchema,
  ),
  "task.checkpoints": entry(idParams, Type.Array(Json)),
  "deliverable.list": list(DeliverableSchema),
  "deliverable.review": entry(
    object({
      id: Id,
      decision: values(["accept", "changes", "reject"]),
      feedback: OptionalText,
      overrideReason: OptionalText,
    }),
    DeliverableSchema,
  ),
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
    object({ value: PipelineVersionSchema, confirmed: Type.Boolean() }),
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
  "workflow.runs": list(WorkflowRunSchema),
  "routine.list": list(RoutineSchema),
  "routine.checkSource": entry(object({ id: Id, revision: Type.Integer() }), RoutineSchema),
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
  "model.catalog": list(Json),
  "model.refresh": entry(object({ definitionId: Type.Optional(Id) }), ok),
  "model.localServers": entry(empty, Type.Array(Json)),
  "workspace.list": list(WorkspaceSchema),
  "workspace.files": entry(
    object({
      threadId: Id,
      query: Type.String({ maxLength: 256 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    object({ items: Type.Array(object({ path: Text, label: Text })), truncated: Type.Boolean() }),
  ),
  "workspace.diff": entry(
    object({ id: Id, path: OptionalText }),
    object({ patch: Text, files: Strings }),
  ),
  "workspace.merge": entry(
    object({ id: Id, mode: values(["merge", "rebase", "cherry_pick"]), confirmed: Type.Boolean() }),
    ok,
  ),
  "workspace.cleanup": entry(
    object({ id: Id, discard: Type.Boolean(), confirmed: Type.Boolean() }),
    ok,
  ),
  "usage.query": entry(
    object({ projectId: Type.Optional(Id), from: Type.Optional(At), to: Type.Optional(At) }),
    Type.Array(UsageRecordSchema),
  ),
  "budget.set": entry(
    object({
      scopeType: Id,
      scopeId: Id,
      usd: Type.Optional(Type.Number({ minimum: 0 })),
      tokens: Type.Optional(Type.Integer({ minimum: 0 })),
      confirmed: Type.Boolean(),
    }),
    ok,
  ),
  "overhead.get": entry(
    object({ sessionId: Id }),
    object({
      injectedTokens: Type.Integer({ minimum: 0 }),
      inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
      cacheRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
  ),
  "settings.get": entry(empty, Type.Array(SettingSchema)),
  "settings.set": entry(
    object({
      key: Id,
      value: Json,
      /** The value the caller last read; a different stored value refuses with setting_conflict. */
      expected: Type.Optional(object({ value: Type.Optional(Json) })),
    }),
    ok,
  ),
  "device.pair.start": entry(empty, object({ url: Text, offerId: Id, expiresAt: At })),
  "device.pair.confirm": entry(
    object({ id: Id, allow: Type.Boolean(), confirmed: Type.Boolean() }),
    DeviceSchema,
  ),
  "device.relay": entry(empty, object({ defaultUrl: Type.Optional(Text) })),
  "device.list": entry(empty, Type.Array(DeviceSchema)),
  "device.revoke": entry(object({ id: Id, confirmed: Type.Boolean() }), ok),
  "diagnostics.export": entry(
    empty,
    object({ versions: Type.Record(Text, Text), checks: Type.Array(Json), logs: Strings }),
  ),
};
export type MethodName = keyof typeof methodCatalog;
/** Refused when the call comes from a paired phone over the relay (D124). */
export const macOnlyMethods: readonly MethodName[] = [
  "compare.create",
  "compare.widen",
  ...shippingMacOnlyMethods,
  ...skillMacOnlyMethods,
  ...browserMacOnlyMethods,
  ...quickChatMacOnlyMethods,
  "routine.checkSource",
  "routine.connectionHandoff",
  "routine.prepare",
  "routine.editEvent",
  "routine.preview",
  "routine.commit",
  "routine.retrySource",
  "routine.archiveHistory",
  "routine.create",
  "connection.install",
  "connection.auth.start",
  "connection.auth.status",
  "connection.auth.cancel",
  "connection.import",
  "connection.save",
  "device.pair.start",
  "device.pair.confirm",
  "detect.startLogin",
  "native.openCommand",
  "diagnostics.export",
];
/**
 * In the catalog but not served by zoltd yet: a call fails with `method_unavailable`. Clients and
 * fakes read this so they do not offer what the Mac cannot do. A daemon test keeps it honest.
 */
export const unservedMethods: readonly MethodName[] = [
  "agent.list",
  "agent.archive",
  "agent.duplicate",
  "thread.list",
  "thread.rename",
  "thread.archive",
  "thread.history",
  "thread.search",
  "turn.retry",
  "native.reconcile",
  "grant.list",
  "grant.set",
  "audit.list",
  "team.killSwitch",
  "project.list",
  "subproject.list",
  "subproject.archive",
  "area.list",
  "area.create",
  "area.update",
  "area.archive",
  "initiative.list",
  "initiative.create",
  "initiative.update",
  "initiative.archive",
  "assignment.set",
  "assignment.end",
  "routing.rules.list",
  "routing.rules.set",
  "limits.get",
  "limits.set",
  "task.update",
  "task.checkpoints",
  "workflow.list",
  "workflow.draftFromTask",
  "workflow.publish",
  "workflow.run",
  "workflow.pause",
  "workflow.runs",
  "model.refresh",
  "model.localServers",
  "workspace.list",
  "workspace.diff",
  "workspace.merge",
  "workspace.cleanup",
];

// Entity events have explicit schemas. Catalog registration also governs the event store.
export const eventCatalog: Record<string, TSchema> = {};
for (const [kind, schema] of Object.entries(entitySchemas)) {
  for (const verb of ["created", "updated", "archived"]) eventCatalog[`${kind}.${verb}`] = schema;
}
for (const name of ["interaction.resolved", "interaction.expired", "interaction.cancelled"])
  eventCatalog[name] = InteractionSchema;
for (const name of ["task.stateChanged", "task.resultSubmitted"])
  eventCatalog[name] = name.endsWith("Submitted") ? TaskResultSchema : TaskSchema;
eventCatalog["item.delta"] = AgentEventSchema;
eventCatalog["item.stream"] = ItemSchema;
for (const [name, schema] of Object.entries(quickChatEvents)) eventCatalog[name] = schema;
eventCatalog["notice.created"] = object({ id: Id, message: Text, code: Id });
eventCatalog["doctor.updated"] = object({ definitionId: Id, status: Text });
export const DomainEventSchema = object({
  seq: Type.Optional(Type.Integer({ minimum: 1 })),
  eventId: Id,
  commandId: Type.Optional(Id),
  aggregateType: Id,
  aggregateId: Id,
  type: Id,
  occurredAt: At,
  payload: Json,
});
export type DomainEvent = import("@sinclair/typebox").Static<typeof DomainEventSchema>;
export function assertCatalogCoverage(methods: readonly string[], events: readonly string[]) {
  for (const method of methods)
    if (!(method in methodCatalog)) throw new Error(`Uncatalogued method: ${method}`);
  for (const event of events)
    if (!(event in eventCatalog)) throw new Error(`Uncatalogued event: ${event}`);
}

export const RpcRequestSchema = object({
  jsonrpc: Type.Literal("2.0"),
  id: Type.Union([Id, Type.Integer()]),
  method: Id,
  params: Json,
  commandId: Type.Optional(Id),
});

for (const [prefix, schema] of [
  ["artifact_version", ArtifactVersionSchema],
  ["artifact_comment", ArtifactCommentSchema],
] as const) {
  for (const verb of ["created", "updated"]) eventCatalog[`${prefix}.${verb}`] = schema;
}

for (const verb of ["voted", "resolved", "closed"]) eventCatalog[`compare.${verb}`] = CompareSchema;
