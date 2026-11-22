import { type TSchema, Type } from "@sinclair/typebox";
import { AgentEventSchema } from "./adapter-events.js";
import { agentTemplateMethods } from "./agent-templates.js";
import {
  ArtifactCommentSchema,
  ArtifactSchema,
  ArtifactTargetSchema,
  ArtifactVersionSchema,
  artifactMethods,
  OutputModeSchema,
} from "./artifacts.js";
import { backupModelMethods } from "./backup-models.js";
import { bridgeMethods } from "./bridges.js";
import { BrowserSelectionSchema, browserMethods } from "./browser.js";
import {
  ChannelPostSchema,
  ChannelRequestSchema,
  ChannelSchema,
  channelMethods,
} from "./channels.js";
import {
  CloudProjectCreateSchema,
  CloudProjectListParamsSchema,
  CloudUsageSchema,
  CommandActorSchema,
  TaskLocationSchema,
} from "./cloud.js";
import {
  At,
  Id,
  Json,
  OptionalText,
  object,
  ScopeSchema,
  Strings,
  Text,
  UserInputSchema,
  values,
} from "./common.js";
import {
  CompanyPlanSchema,
  companyMethods,
  InitiativeRecordSchema,
  ManagerRemitSchema,
  ProjectBriefSchema,
} from "./company.js";
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
  TaskDocumentChangesSchema,
  TaskDocumentInputSchema,
  TaskResultSchema,
  TaskSchema,
  ThreadSchema,
  TurnSchema,
  WorkspaceSchema,
} from "./entities.js";
import { ForkBoundarySchema, ForkKindSchema, ForkOperationSchema } from "./forks.js";
import { inboxMethods } from "./inbox.js";
import {
  ApprovalRuleSchema,
  InteractionSchema,
  ResolutionSchema,
  RuleDraftSchema,
} from "./interactions.js";
import { knowledgeWorkflowMethods } from "./knowledge-workflow-methods.js";
import {
  ContextPackSchema,
  DeliverableSchema,
  KnowledgeItemSchema,
  PipelineVersionSchema,
  RoutineOccurrenceSchema,
  RoutineSchema,
  WorkflowRunSchema,
} from "./knowledge-workflows.js";
import { KnowledgeProposalSchema, knowledgeWriteMethods } from "./knowledge-writes.js";
import { MacOutputSnapshotSchema } from "./mac-approval.js";
import { withMethodLocations } from "./method-locations.js";
import { OrchestrationSchema, orchestrationMethods } from "./orchestration.js";
import { projectDataMethods } from "./project-data.js";
import { quickChatEvents, quickChatMethods } from "./quick-chat.js";
import {
  ShippingFeedbackSchema,
  ShippingOperationSchema,
  ShippingSchema,
  shippingMethods,
} from "./shipping.js";
import { SkillProposalSchema, skillMethods } from "./skills.js";
import { staffMethods } from "./staff.js";
import { terminalMethods } from "./terminal.js";
import { vaultMethods } from "./vault.js";

import { ViewRecordSchema, viewMethods } from "./views.js";
import { WakeSchema, wakeMethods } from "./wakes.js";

export const entitySchemas = {
  view: ViewRecordSchema,
  initiativeRecord: InitiativeRecordSchema,
  managerRemit: ManagerRemitSchema,
  companyPlan: CompanyPlanSchema,
  projectBrief: ProjectBriefSchema,
  channel: ChannelSchema,
  channelPost: ChannelPostSchema,
  channelRequest: ChannelRequestSchema,
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
  skillProposal: SkillProposalSchema,
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
const VoiceList = Type.Array(object({ id: Type.String(), name: Type.String() }), { maxItems: 200 });
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

const rawMethodCatalog = {
  "cloud.project.create": entry(CloudProjectCreateSchema, ProjectSchema),
  "cloud.project.list": entry(
    CloudProjectListParamsSchema,
    object({ items: Type.Array(ProjectSchema), cursor: OptionalText }),
  ),
  "usage.get": entry(empty, CloudUsageSchema),
  "cloud.mac.output": entry(object({ taskId: Id, requestId: Id }), MacOutputSnapshotSchema),
  ...viewMethods,
  ...companyMethods,
  ...channelMethods,
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
  ...backupModelMethods,
  ...vaultMethods,
  ...projectDataMethods,
  ...staffMethods,
  ...agentTemplateMethods,
  ...bridgeMethods,
  hello: entry(
    object({ protocolVersion: Type.Integer({ minimum: 1 }), token: Text }),
    object({
      protocolVersion: Type.Integer(),
      version: Text,
      // I8: where the owner installs the GitHub App; only when this daemon has a cloud account.
      githubInstallUrl: Type.Optional(Text),
    }),
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
  // D7: agents, memory, skills, routines, the company and settings, to and from a ZIP.
  "export.bundle": entry(
    object({ path: Text }),
    object({ path: Text, counts: Type.Record(Text, Type.Integer()) }),
  ),
  "import.bundle": entry(
    object({ path: Text }),
    object({
      previewId: Id,
      agents: Type.Integer(),
      items: Type.Array(Json),
      connections: Strings,
      tools: Strings,
    }),
  ),
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
  "thread.pin": entry(object({ id: Id, pinned: Type.Boolean() }), ThreadSchema),
  "thread.archive": thread.archive,
  "thread.delete": entry(object({ id: Id, confirmed: Type.Boolean() }), ok),
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
  /** C2: asks a side question in a read-only copy of the chat; returns the aside's thread id. */
  "turn.aside": entry(
    object({ threadId: Id, text: Type.String({ minLength: 1, maxLength: 4000 }) }),
    object({ threadId: Id }),
  ),
  /** C2: turns an aside into a normal chat, listed like any other. */
  "thread.continueAside": entry(object({ id: Id }), ThreadSchema),
  /** O1: whether an ElevenLabs key is set up. */
  "voice.status": entry(object({}), object({ elevenlabs: Type.Boolean() })),
  /**
   * O1: checks the owner's ElevenLabs key by listing its voices, then keeps it in the keychain.
   * Fails with voice_key_rejected, voice_limit, voice_unreachable or keychain_unavailable.
   */
  "voice.key.set": entry(
    object({ key: Type.String({ minLength: 1, maxLength: 200 }) }),
    object({ voices: VoiceList }),
  ),
  "voice.key.clear": entry(object({}), object({})),
  /** O1: the key's voices. Fails with voice_not_set_up or the voice.key.set errors. */
  "voice.voices": entry(object({}), object({ voices: VoiceList })),
  /**
   * O1 and O5: one piece of a reply as MP3, base64. Text holding a private value isn't sent
   * (private_value). Also fails with voice_not_set_up, voice_not_found and the key errors.
   */
  "voice.speak": entry(
    object({
      text: Type.String({ minLength: 1, maxLength: 400 }),
      voiceId: Type.String({ minLength: 1, maxLength: 64 }),
    }),
    object({ mime: Text, data: Text }),
  ),
  /** O2: records a finished call in its chat. Fails with call_time_invalid or thread_not_found. */
  "voice.call.log": entry(
    object({
      threadId: Id,
      startedAt: Type.String({ maxLength: 40 }),
      endedAt: Type.String({ maxLength: 40 }),
    }),
    object({}),
  ),
  /** C4: pins are newest first. Pinning fails with pin_limit past 50 pins in one chat. */
  "message.pin": entry(
    object({ threadId: Id, itemId: Id }),
    object({ pins: Type.Array(object({ itemId: Id, pinnedAt: Type.String() }), { maxItems: 50 }) }),
  ),
  /** C5: display only; the provider's session keeps the message (I2, I11). */
  "message.hide": entry(
    object({ threadId: Id, itemId: Id }),
    object({ hidden: Type.Array(Id, { maxItems: 500 }) }),
  ),
  "message.unhide": entry(
    object({ threadId: Id, itemId: Id }),
    object({ hidden: Type.Array(Id, { maxItems: 500 }) }),
  ),
  /** C8: the owner's reaction; null clears it. Agents react with the chat_signal tool. */
  "message.react": entry(
    object({ threadId: Id, itemId: Id, emoji: Type.Union([Type.String(), Type.Null()]) }),
    object({ reactions: Type.Array(Type.Unknown(), { maxItems: 500 }) }),
  ),
  "message.unpin": entry(
    object({ threadId: Id, itemId: Id }),
    object({ pins: Type.Array(object({ itemId: Id, pinnedAt: Type.String() }), { maxItems: 50 }) }),
  ),
  /**
   * C16: a file or picture the owner sent, read from this Mac for the phone, up to 5 MB, or a PDF up
   * to 25 MB or a video up to 50 MB. `data` is text for text and SVG kinds and base64 for pictures,
   * PDFs and videos, in pieces that fit one link frame: call again
   * with `offset: next` and the same `stamp` until `next` is null. Fails with
   * attachment_preview_unavailable, attachment_preview_too_large or attachment_changed.
   */
  "attachment.preview": entry(
    object({
      threadId: Id,
      itemId: Id,
      part: Type.Integer({ minimum: 0, maximum: 63 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      stamp: OptionalText,
    }),
    object({
      kind: values(["image", "svg", "text", "csv", "tsv", "markdown", "zip", "pdf", "video"]),
      name: Text,
      mime: Text,
      size: Type.Integer({ minimum: 0 }),
      stamp: Text,
      data: Text,
      next: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    }),
  ),
  /**
   * C15: a card for a link in a message: the page's title, site name, a line of description and a
   * picture under 200 KB as a data URL. The Mac fetches it from public addresses only. Fails with
   * link_not_in_message, link_previews_off, link_private, link_unreachable, link_timeout,
   * link_too_large, link_redirects, link_unsupported or link_not_page.
   */
  "link.preview": entry(
    object({ threadId: Id, itemId: Id, url: Type.String({ minLength: 1, maxLength: 2048 }) }),
    object({
      url: Text,
      title: Text,
      siteName: Text,
      description: OptionalText,
      image: Type.Optional(Type.String({ maxLength: 280_000 })),
    }),
  ),
  /** C1: `order` lists every queued item id of the thread; fails with queue_changed otherwise. */
  "turn.reorderQueued": entry(
    object({ threadId: Id, order: Type.Array(Id, { maxItems: 200 }) }),
    ok,
  ),
  /** C1: steers the running turn when the agent supports it, else moves the item to the front. */
  "turn.sendQueuedNow": entry(
    object({ threadId: Id, id: Id }),
    object({ ok: Type.Boolean(), delivery: values(["steer", "next"]) }),
  ),
  "turn.interrupt": entry(object({ threadId: Id, turnId: Id }), ok),
  "turn.retry": entry(object({ threadId: Id }), ok),
  "session.compact": entry(object({ id: Id, instructions: OptionalText }), ok),
  /** How much of the thread's live session context is used. Empty when the provider doesn't say. */
  "session.context": entry(
    object({ threadId: Id }),
    object({
      used: Type.Optional(Type.Integer({ minimum: 0 })),
      size: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
  "session.connect": entry(object({ threadId: Id, previousSessionId: Type.Optional(Id) }), ok),
  "session.setModel": entry(
    object({ id: Id, model: Text, effort: OptionalText, cacheWarningAccepted: Type.Boolean() }),
    ok,
  ),
  "session.setEffort": entry(
    object({ id: Id, effort: Text, cacheWarningAccepted: Type.Boolean() }),
    ok,
  ),
  /** A5: null returns the session to the provider's standard tier. */
  "session.setServiceTier": entry(object({ id: Id, tier: Type.Union([Text, Type.Null()]) }), ok),
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
      document: Type.Optional(TaskDocumentInputSchema),
      location: Type.Optional(TaskLocationSchema),
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
  "document.changes": entry(idParams, TaskDocumentChangesSchema),
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
      reviewedCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
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
  ...knowledgeWorkflowMethods,
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
  // D6: removes saved logins and marks the data folder; the next start empties it.
  "maintenance.startFresh": entry(
    object({ confirm: Type.Literal("start fresh") }),
    object({ kept: Strings }),
  ),
};
export type MethodName = keyof typeof rawMethodCatalog;
export const methodCatalog = withMethodLocations(rawMethodCatalog);
export type { MethodWhere } from "./method-locations.js";
/** Refused when the call comes from a paired phone over the relay (D124). */
export const macOnlyMethods: readonly MethodName[] = (
  Object.keys(methodCatalog) as MethodName[]
).filter((method) => !methodCatalog[method].pairedPhone);
export { unservedMethods } from "./unserved-methods.js";

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
eventCatalog["thread.deleted"] = object({ id: Id });
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
  actor: Type.Optional(CommandActorSchema),
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
