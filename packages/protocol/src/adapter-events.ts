import { type Static, Type } from "@sinclair/typebox";
import {
  BackgroundTaskSchema,
  DiffSchema,
  Id,
  Json,
  LocationSchema,
  OptionalText,
  object,
  PlanEntrySchema,
  Strings,
  Text,
  ToolKindSchema,
  UsageSampleSchema,
  UserErrorSchema,
  values,
} from "./common.js";
import { NativeForkCapabilitiesSchema } from "./forks.js";
import { InteractionDraftSchema } from "./interactions.js";

export const NativeCommandSchema = object({
  name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_][a-zA-Z0-9_:./-]*$" }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  argumentHint: Type.Optional(Type.String({ maxLength: 256 })),
});
export type NativeCommand = Static<typeof NativeCommandSchema>;
export const CapabilitiesSchema = object({
  nativeFork: Type.Optional(NativeForkCapabilitiesSchema),
  slashCommands: Type.Optional(Type.Array(NativeCommandSchema, { maxItems: 100 })),
  resume: Type.Boolean(),
  fork: Type.Boolean(),
  steer: values(["native", "queue_only"]),
  concurrentTurns: Type.Boolean(),
  interrupt: values(["native", "kill"]),
  modes: Strings,
  /**
   * Modes that never widen permission. Any other mode is treated as widening (I13): clients ask
   * for confirmation and the daemon requires confirmed: true. Absent means every mode widens.
   */
  safeModes: Type.Optional(Strings),
  models: object({
    selectable: Type.Boolean(),
    list: Type.Optional(Type.Array(object({ id: Id, name: Text }))),
  }),
  effort: Strings,
  approvals: values(["granular", "coarse", "none"]),
  questions: values(["native", "none"]),
  questionFeatures: Type.Optional(
    object({
      multi: Type.Boolean(),
      other: Type.Boolean(),
      recommended: Type.Boolean(),
      maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    }),
  ),
  planReview: values(["native", "none"]),
  elicitation: values(["form", "none"]),
  usage: object({
    tokens: Type.Boolean(),
    cost: Type.Boolean(),
    context: Type.Boolean(),
    cache: Type.Boolean(),
  }),
  compaction: object({ auto: Type.Boolean(), manual: Type.Boolean(), events: Type.Boolean() }),
  hostTools: values(["mcp_http", "mcp_stdio", "dynamic", "extension", "none"]),
  images: Type.Boolean(),
  nativeSessions: object({
    list: Type.Boolean(),
    adopt: Type.Boolean(),
    visibleInOfficialApps: values(["yes", "no", "unknown"]),
  }),
  worktreeAware: Type.Boolean(),
  /** Native file checkpoints can restore files to the state before a given turn. */
  rewind: Type.Optional(Type.Boolean()),
  /** The provider reports background shell or agent tasks and can stop them. */
  backgroundTasks: Type.Optional(Type.Boolean()),
});
export type Capabilities = Static<typeof CapabilitiesSchema>;
const turn = { turnId: Id };
const item = { turnId: Id, itemId: Id, parentItemId: Type.Optional(Id) };
export const agentEventSchemas = {
  "session.ready": object({
    t: Type.Literal("session.ready"),
    nativeId: Id,
    capabilities: CapabilitiesSchema,
    providerVersion: Text,
  }),
  "capabilities.updated": object({
    t: Type.Literal("capabilities.updated"),
    capabilities: CapabilitiesSchema,
    providerVersion: OptionalText,
  }),
  "turn.started": object({ t: Type.Literal("turn.started"), ...turn }),
  "text.delta": object({ t: Type.Literal("text.delta"), ...item, text: Text }),
  "message.done": object({
    t: Type.Literal("message.done"),
    ...item,
    text: Text,
    phase: values(["commentary", "final"]),
  }),
  "thought.delta": object({ t: Type.Literal("thought.delta"), ...item, text: Text }),
  "thought.done": object({ t: Type.Literal("thought.done"), ...item, text: Text }),
  "tool.started": object({
    /** Recomputed by the daemon before privacy redaction; never carries command text. */
    check: Type.Optional(Type.Literal("tests")),
    t: Type.Literal("tool.started"),
    ...item,
    name: Text,
    kind: ToolKindSchema,
    input: Json,
    locations: Type.Optional(Type.Array(LocationSchema)),
    /** Provider-neutral one line summary, e.g. a command, path, pattern, or URL. */
    title: OptionalText,
    /** Surfaced to the human as an interaction card; timelines render it compactly. */
    interactive: Type.Optional(Type.Boolean()),
  }),
  "tool.updated": object({
    t: Type.Literal("tool.updated"),
    itemId: Id,
    parentItemId: Type.Optional(Id),
    output: Type.Optional(Json),
    content: Type.Optional(Type.Array(Json)),
  }),
  "tool.done": object({
    t: Type.Literal("tool.done"),
    itemId: Id,
    parentItemId: Type.Optional(Id),
    status: values(["ok", "error", "denied"]),
    output: Type.Optional(Json),
    diffs: Type.Optional(Type.Array(DiffSchema)),
  }),
  "plan.updated": object({
    t: Type.Literal("plan.updated"),
    ...turn,
    entries: Type.Array(PlanEntrySchema),
  }),
  "interaction.requested": object({
    t: Type.Literal("interaction.requested"),
    interaction: InteractionDraftSchema,
  }),
  "interaction.cleared": object({
    t: Type.Literal("interaction.cleared"),
    nativeRef: Text,
    reason: values(["provider_resolved", "turn_ended", "process_died"]),
  }),
  "usage.updated": object({
    t: Type.Literal("usage.updated"),
    turnId: Type.Optional(Id),
    usage: UsageSampleSchema,
  }),
  compaction: object({
    t: Type.Literal("compaction"),
    state: values(["started", "done"]),
    trigger: values(["auto", "manual"]),
    tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
    tokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  status: object({
    t: Type.Literal("status"),
    state: values(["ready", "auth_required", "rate_limited", "error", "reconnecting"]),
    detail: OptionalText,
    resetsAt: OptionalText,
  }),
  "mode.changed": object({ t: Type.Literal("mode.changed"), mode: Text }),
  "background.updated": object({
    t: Type.Literal("background.updated"),
    task: BackgroundTaskSchema,
  }),
  "queue.updated": object({
    t: Type.Literal("queue.updated"),
    pending: Type.Integer({ minimum: 0 }),
  }),
  "turn.done": object({
    t: Type.Literal("turn.done"),
    ...turn,
    status: values(["completed", "failed", "interrupted"]),
    stopReason: OptionalText,
    error: Type.Optional(UserErrorSchema),
  }),
};
export const AgentEventSchema = Type.Union(Object.values(agentEventSchemas));
export type AgentEvent = Static<typeof AgentEventSchema>;
