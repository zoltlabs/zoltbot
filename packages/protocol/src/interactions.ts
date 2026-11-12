import { type Static, Type } from "@sinclair/typebox";
import {
  ActorSchema,
  At,
  DiffSchema,
  Id,
  Json,
  OptionalText,
  object,
  Strings,
  Text,
  ToolKindSchema,
  values,
} from "./common.js";
import { MacApprovalDraftSchema, SignedMacApprovalSchema } from "./mac-approval.js";

export const RuleMatcherSchema = object({
  tool: Text,
  kind: Type.Optional(ToolKindSchema),
  command: Type.Optional(object({ prefix: Type.Array(Text, { minItems: 1 }) })),
  paths: Type.Optional(Strings),
  host: OptionalText,
  mcp: Type.Optional(object({ server: Text, tool: Text })),
});
export const RuleDraftSchema = object({
  scope: values(["global", "project", "agent"]),
  scopeId: Type.Optional(Id),
  matcher: RuleMatcherSchema,
  decision: values(["allow", "deny"]),
  expiresAt: Type.Optional(At),
});
export type RuleDraft = Static<typeof RuleDraftSchema>;
export const ApprovalChoiceSchema = Type.Union([
  object({ id: Type.Literal("allow_task_prefix"), prefix: Text }),
  object({
    id: values(["allow_once", "allow_session", "reject_once", "allow_accept_edits"]),
    /** Short native description of what the choice grants, e.g. "Bash(npm test:*)". */
    label: OptionalText,
  }),
  object({ id: values(["allow_rule", "reject_rule"]), rule: RuleDraftSchema }),
]);
export const InteractionItemSchema = object({
  id: Id,
  header: Type.Optional(Type.String({ maxLength: 12 })),
  prompt: Type.String({ maxLength: 2000 }),
  options: Type.Optional(
    Type.Array(
      object({
        id: Id,
        label: Text,
        description: OptionalText,
        recommended: Type.Optional(Type.Boolean()),
      }),
      { maxItems: 8 },
    ),
  ),
  multi: Type.Optional(Type.Boolean()),
  allowOther: Type.Optional(Type.Boolean()),
  secret: Type.Optional(Type.Boolean()),
  schema: Type.Optional(Json),
  choices: Type.Optional(Type.Array(ApprovalChoiceSchema)),
  default: OptionalText,
});
export const ResolutionSchema = object({
  signedApproval: Type.Optional(SignedMacApprovalSchema),
  action: values(["accept", "decline", "cancel", "timeout", "expire"]),
  answers: Type.Optional(
    Type.Record(
      Id,
      object({ options: Type.Optional(Strings), other: OptionalText, value: Type.Optional(Json) }),
    ),
  ),
  choice: OptionalText,
  feedback: OptionalText,
  by: ActorSchema,
  device: OptionalText,
  via: Type.Optional(object({ kind: Type.Literal("view"), id: Id })),
  at: At,
  automatic: Type.Optional(Type.Boolean()),
});
export type InteractionAnswer = Static<typeof ResolutionSchema>;
export const InteractionContextSchema = object({
  macExec: Type.Optional(MacApprovalDraftSchema),
  markdown: OptionalText,
  toolName: OptionalText,
  toolKind: Type.Optional(ToolKindSchema),
  command: OptionalText,
  cwd: OptionalText,
  diffs: Type.Optional(Type.Array(DiffSchema)),
  paths: Type.Optional(Strings),
  network: Type.Optional(object({ host: Text, protocol: Text })),
  toolInput: Type.Optional(Json),
  /** A narrow rule the provider proposes; the UI offers it as "Always allow" via rule.create. */
  ruleSuggestion: Type.Optional(RuleMatcherSchema),
  deliverable: Type.Optional(
    object({
      id: Id,
      kind: Text,
      summary: Text,
      previewRef: OptionalText,
      checks: Type.Array(Json),
    }),
  ),
});
export const InteractionDraftSchema = object({
  id: Id,
  agentId: Id,
  threadId: Id,
  turnId: Type.Optional(Id),
  taskId: Type.Optional(Id),
  type: values(["question", "approval", "plan", "form", "gate"]),
  title: OptionalText,
  context: Type.Optional(InteractionContextSchema),
  items: Type.Array(InteractionItemSchema, { minItems: 1, maxItems: 4 }),
  chain: Type.Array(ActorSchema),
  urgency: values(["blocking", "background"]),
  timeout: Type.Optional(
    object({
      seconds: Type.Number({ exclusiveMinimum: 0 }),
      onTimeout: values(["use_default", "reject", "park"]),
    }),
  ),
  nativeRef: OptionalText,
});
export const InteractionSchema = object({
  ...InteractionDraftSchema.properties,
  version: Type.Integer({ minimum: 1 }),
  state: values(["pending", "answered", "cancelled", "expired"]),
  resolution: Type.Optional(ResolutionSchema),
  createdAt: At,
  resolvedAt: Type.Optional(At),
});
export type Interaction = Static<typeof InteractionSchema>;
export type InteractionDraft = Static<typeof InteractionDraftSchema>;
export const ApprovalRuleSchema = object({
  ...RuleDraftSchema.properties,
  id: Id,
  createdBy: ActorSchema,
  createdAt: At,
  revokedAt: Type.Optional(At),
});

export type ApprovalRule = Static<typeof ApprovalRuleSchema>;
/** D119 approvals belong to the host, not a native turn, so session and turn ends keep them. */
export const HOST_WORKSPACE_REF = "host:workspace";
