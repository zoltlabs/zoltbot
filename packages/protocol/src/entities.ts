import { type Static, Type } from "@sinclair/typebox";
import { OutputModeSchema } from "./artifacts.js";
import { BrowserSelectionSchema } from "./browser.js";
import {
  ActorSchema,
  At,
  BackgroundTaskSchema,
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
import { ForkProvenanceSchema } from "./forks.js";
import { RoutineInputsSchema } from "./knowledge-workflows.js";
import { PhaseExecutionSchema } from "./orchestration.js";

export const ProfileSchema = object({
  template: Type.Optional(Type.Literal("artifact_designer")),
  id: Id,
  name: Text,
  avatar: Text,
  kind: values(["profile", "chief_of_staff"]),
  definitionId: Id,
  model: OptionalText,
  effort: OptionalText,
  permissionProfile: PermissionProfileSchema,
  instructions: Text,
  roleText: OptionalText,
  hidden: Type.Boolean(),
  archived: Type.Boolean(),
  createdAt: Type.Optional(At),
  updatedAt: Type.Optional(At),
});
export type Profile = Static<typeof ProfileSchema>;
export const ProjectSchema = object({
  artifactDesignContextId: Type.Optional(Type.Union([Id, Type.Null()])),
  artifactRepositoryMode: Type.Optional(values(["on_accept", "every_save", "off"])),
  /** Absolute paths chats read for design and page work. Absent or null: found automatically. */
  designFiles: Type.Optional(Type.Union([Type.Array(Text, { maxItems: 20 }), Type.Null()])),
  /** Profile new chats in this workspace start with. Absent or null: the lead chat's, else the first. */
  defaultAgentId: Type.Optional(Type.Union([Id, Type.Null()])),
  id: Id,
  name: Text,
  goal: Text,
  instructions: Text,
  constraints: Text,
  roots: Type.Array(object({ path: Text, repoRoot: OptionalText, label: Text })),
  hierarchyDepth: Type.Integer({ minimum: 0, maximum: 3 }),
  tags: Strings,
  defaultBudgetUsd: Type.Optional(Type.Number({ minimum: 0 })),
  setupScript: OptionalText,
  previewCommand: OptionalText,
  previewUrl: OptionalText,
  requireCodeReview: Type.Boolean(),
  skipFinalGateWhenReviewed: Type.Boolean(),
  archived: Type.Boolean(),
  createdAt: At,
});
export type Project = Static<typeof ProjectSchema>;
export const SubprojectSchema = object({
  id: Id,
  projectId: Id,
  parentId: Type.Optional(Id),
  name: Text,
  label: Text,
  goal: Text,
  instructions: Text,
  depth: Type.Integer({ minimum: 1, maximum: 3 }),
  archived: Type.Boolean(),
  createdAt: At,
});
export type Subproject = Static<typeof SubprojectSchema>;
export const ThreadSchema = object({
  fork: Type.Optional(ForkProvenanceSchema),
  id: Id,
  agentId: Id,
  projectId: Type.Optional(Id),
  node: Type.Optional(ScopeSchema),
  taskId: Type.Optional(Id),
  kind: values(["main", "task", "side", "manager"]),
  title: Text,
  titleSource: values(["auto", "human", "provider"]),
  pinned: Type.Boolean(),
  archived: Type.Boolean(),
  createdAt: At,
  lastActivityAt: At,
  /** When the owner last opened the thread, on any device. Drives "Ready to review". */
  lastReadAt: Type.Optional(At),
  /** Hidden in the Later mailbox until then, unless the agent asks for something. */
  snoozedUntil: Type.Optional(At),
  wakePending: Type.Optional(Type.Boolean()),
  wakeUnreadAt: Type.Optional(At),
  /** Settled while still working: archive it once the work ends. */
  archiveWhenIdle: Type.Optional(Type.Boolean()),
});
export type Thread = Static<typeof ThreadSchema>;
export const SessionStateSchema = values(["starting", "ready", "running", "closed", "failed"]);
export const SessionEndReasonSchema = values([
  "runtime_closed",
  "daemon_restart",
  "auth_required",
  "read_only_mode_unavailable",
  "http_mcp_not_supported",
  "unsupported_model_selection",
  "unsupported_effort",
  "runtime_process_error",
  "runtime_stream_ended",
  "runtime_event_failed",
  "runtime_dispatch_failed",
  "runtime_open_failed",
  "runtime_cleanup_required",
  "injection_budget_exceeded",
  "delivery_uncertain",
  "interaction_timeout",
  "interrupt_delivery_uncertain",
  "interaction_delivery_uncertain",
]);
export type SessionEndReason = Static<typeof SessionEndReasonSchema>;
export const RuntimeStatusSchema = object({
  state: values(["auth_required", "rate_limited", "error", "reconnecting"]),
  detail: OptionalText,
  resetsAt: OptionalText,
  observedAt: At,
});
export const SessionSchema = object({
  runtimeStatus: Type.Optional(RuntimeStatusSchema),
  id: Id,
  threadId: Id,
  provider: Id,
  nativeId: Type.Optional(Id),
  cwd: Text,
  workspaceId: Type.Optional(Id),
  state: SessionStateSchema,
  model: OptionalText,
  effort: OptionalText,
  capabilities: Json,
  providerVersion: OptionalText,
  /** Current native permission mode as last reported by the adapter. */
  mode: OptionalText,
  /** Background tasks reported by the provider for this session, newest last. */
  background: Type.Optional(Type.Array(BackgroundTaskSchema, { maxItems: 50 })),
  startedAt: At,
  endedAt: Type.Optional(At),
  endReason: Type.Optional(SessionEndReasonSchema),
  generation: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
export const TurnSchema = object({
  nativeTurnId: Type.Optional(Id),
  id: Id,
  threadId: Id,
  sessionId: Id,
  status: values(["running", "completed", "failed", "interrupted"]),
  origin: values(["human", "agent", "system"]),
  startedAt: At,
  endedAt: Type.Optional(At),
  stopReason: OptionalText,
  error: Type.Optional(Json),
});
export const ItemSchema = object({
  id: Id,
  threadId: Id,
  turnId: Type.Optional(Id),
  seq: Type.Integer({ minimum: 1 }),
  kind: values(["user", "message", "thought", "tool", "plan", "interaction", "note"]),
  phase: Type.Optional(values(["commentary", "final"])),
  body: Json,
  createdAt: At,
  updatedAt: At,
});
export const TaskStateSchema = values([
  "queued",
  "running",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskState = Static<typeof TaskStateSchema>;
export const TaskSchema = object({
  accountableThreadId: Type.Optional(Id),
  pendingAccountableThreadId: Type.Optional(Id),
  assignmentHistory: Type.Optional(Type.Array(object({ threadId: Id, at: At }))),
  dependencies: Type.Optional(Type.Array(Id)),
  planned: Type.Optional(Type.Boolean()),
  authorityPlanId: Type.Optional(Id),
  phaseExecution: Type.Optional(PhaseExecutionSchema),
  outputMode: Type.Optional(OutputModeSchema),
  id: Id,
  projectId: Type.Optional(Id),
  areaId: Type.Optional(Id),
  initiativeId: Type.Optional(Id),
  node: Type.Optional(ScopeSchema),
  routineOccurrenceId: Type.Optional(Id),
  permissionCeiling: Type.Optional(PermissionProfileSchema),
  routineInputs: Type.Optional(RoutineInputsSchema),
  browser: Type.Optional(BrowserSelectionSchema),
  workflowRunId: Type.Optional(Id),
  stageId: Type.Optional(Id),
  parentId: Type.Optional(Id),
  rootId: Id,
  title: Text,
  brief: Text,
  acceptance: Text,
  expectedDeliverable: Text,
  ownerAgentId: Type.Optional(Id),
  threadId: Type.Optional(Id),
  workspaceMode: values(["shared", "worktree"]),
  workspaceId: Type.Optional(Id),
  baseRef: OptionalText,
  budgetUsd: Type.Optional(Type.Number({ minimum: 0 })),
  budgetTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  state: TaskStateSchema,
  revision: Type.Integer({ minimum: 1 }),
  attempt: Type.Integer({ minimum: 1 }),
  maxAttempts: Type.Integer({ minimum: 1 }),
  reviewRequired: Type.Boolean(),
  reviewState: OptionalText,
  executionLocation: Text,
  holdReason: OptionalText,
  createdBy: ActorSchema,
  createdAt: At,
  updatedAt: At,
});
export type Task = Static<typeof TaskSchema>;
export const TaskResultSchema = object({
  outcome: Type.Optional(values(["nothing", "actionable", "needs_you"])),
  taskId: Id,
  revision: Type.Integer({ minimum: 1 }),
  status: values(["done", "partial", "blocked", "failed"]),
  summary: Type.String({ maxLength: 2000 }),
  files: Type.Array(Text, { maxItems: 200 }),
  digest: Type.String({ maxLength: 1500 }),
  auto: Type.Boolean(),
  createdAt: At,
});
export const WorkspaceSchema = object({
  id: Id,
  projectId: Type.Optional(Id),
  kind: values(["folder", "worktree"]),
  path: Text,
  repoRoot: OptionalText,
  branch: OptionalText,
  baseRef: OptionalText,
  state: values(["active", "orphaned", "removed"]),
  createdAt: At,
});
export const NativeSessionSchema = object({
  provider: Id,
  nativeId: Id,
  cwd: OptionalText,
  title: OptionalText,
  lastActivityAt: Type.Optional(At),
  source: OptionalText,
  threadId: Type.Optional(Id),
  adopted: Type.Boolean(),
  missing: Type.Boolean(),
  lastSeenAt: At,
});
export const AuditSchema = object({
  id: Id,
  actor: ActorSchema,
  action: Id,
  target: OptionalText,
  chain: Type.Optional(Type.Array(ActorSchema)),
  result: Text,
  detail: Type.Optional(Json),
  at: At,
});
export const SettingSchema = object({ key: Id, value: Json });
export const AgentDefinitionSchema = object({
  id: Id,
  displayName: Text,
  adapter: Id,
  flavor: OptionalText,
  binaryNames: Strings,
  versionCommand: Strings,
  launch: object({ command: Text, args: Strings, env: Type.Record(Text, Text) }),
  auth: Type.Optional(
    object({
      statusCommand: Type.Optional(Strings),
      loginCommand: Type.Optional(Strings),
      apiKeyEnv: OptionalText,
    }),
  ),
  install: Type.Optional(object({ docsUrl: Text, command: OptionalText })),
  /** The provider's own update command and where its latest release is published. */
  update: Type.Optional(
    object({
      args: Strings,
      latest: object({ url: Text, key: OptionalText, pattern: OptionalText }),
    }),
  ),
  testedVersions: Text,
  defaults: object({ permissionProfile: PermissionProfileSchema }),
  staticCapabilities: Type.Record(Text, Json),
  nativeSessionRoots: Strings,
  experimental: Type.Boolean(),
});
export type AgentDefinition = Static<typeof AgentDefinitionSchema>;
export type NativeSessionInfo = Static<typeof NativeSessionSchema>;
/** A phone paired through the relay (D124). `id` is its link id; the key is its Ed25519 key. */
export const DeviceSchema = object({
  id: Id,
  name: Text,
  platform: values(["ios"]),
  publicKey: Text,
  state: values(["pending", "paired", "revoked"]),
  confirmCode: OptionalText,
  createdAt: At,
  pairedAt: Type.Optional(At),
  lastSeenAt: Type.Optional(At),
  archived: Type.Boolean(),
});
export type Device = Static<typeof DeviceSchema>;
