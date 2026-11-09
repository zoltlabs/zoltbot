import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  ActorSchema,
  At,
  Id,
  OptionalText,
  object,
  ScopeSchema,
  Strings,
  Text,
  values,
} from "./common.js";
import { KnowledgeItemSchema, SourceRefSchema } from "./knowledge-workflows.js";

/** File 12 section 6.2 outcomes. The daemon decides, never the agent. */
export const KnowledgeWriteOutcomeSchema = values(["applied", "proposed", "merged", "rejected"]);
export const KnowledgeWriteReasonSchema = values([
  "secret_detected",
  "cap_reached",
  "no_evidence",
  "scope_denied",
  "stale_revision",
  "not_durable",
  "previously_rejected",
  "duplicate",
  "user_scope",
  "protected_item",
  "tainted",
  "grant_required",
  "own_node",
  "low_risk",
  "granted",
  "confirmed",
  "not_found",
]);
export type KnowledgeWriteReason = Static<typeof KnowledgeWriteReasonSchema>;
export const KnowledgeKindSchema = KnowledgeItemSchema.properties.kind;
export const KnowledgeProposalSchema = object({
  id: Id,
  state: values(["pending", "accepted", "rejected"]),
  op: values(["create", "revise", "confirm"]),
  itemId: Type.Optional(Id),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  scope: ScopeSchema,
  kind: KnowledgeKindSchema,
  key: OptionalText,
  title: Text,
  body: Type.String({ maxLength: 1200 }),
  tags: Strings,
  evidence: Type.Array(SourceRefSchema),
  /** The agent's one-line reason. */
  reason: Type.String({ maxLength: 300 }),
  /** Why the policy routed this write to review. */
  why: KnowledgeWriteReasonSchema,
  writer: ActorSchema,
  sessionId: Id,
  taskId: Type.Optional(Id),
  threadId: Type.Optional(Id),
  /** Normalized identity used to auto-reject identical future writes after a rejection. */
  fingerprint: Id,
  conflicts: Type.Array(Id),
  decidedBy: Type.Optional(ActorSchema),
  decidedAt: Type.Optional(At),
  rejectionReason: OptionalText,
  resultItemId: Type.Optional(Id),
  createdAt: At,
  updatedAt: At,
});
export type KnowledgeProposal = Static<typeof KnowledgeProposalSchema>;
export const KnowledgeWriteRecordSchema = object({
  id: Id,
  sessionId: Id,
  taskId: Type.Optional(Id),
  threadId: Type.Optional(Id),
  source: values(["tool", "learned"]),
  op: values(["create", "revise", "confirm"]),
  outcome: KnowledgeWriteOutcomeSchema,
  reason: KnowledgeWriteReasonSchema,
  itemId: Type.Optional(Id),
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
  proposalId: Type.Optional(Id),
  scope: Type.Optional(ScopeSchema),
  kind: Type.Optional(KnowledgeKindSchema),
  /** Omitted for rejected writes so rejected text never persists. */
  title: OptionalText,
  at: At,
});
export type KnowledgeWriteRecord = Static<typeof KnowledgeWriteRecordSchema>;
export const SessionTaintCauseSchema = values([
  "fetch",
  "browser",
  "connected_app",
  "outside_workspace",
  "attachment",
  "cross_project_message",
  "unknown",
]);
export type SessionTaintCause = Static<typeof SessionTaintCauseSchema>;
export const SessionTaintSchema = object({
  sessionId: Id,
  cause: SessionTaintCauseSchema,
  /** Tool name or source label only; never ingested content. */
  label: OptionalText,
  at: At,
});
export type SessionTaint = Static<typeof SessionTaintSchema>;

const entry = <P extends TSchema, R extends TSchema>(params: P, result: R) => ({ params, result });
const ok = object({ ok: Type.Boolean() });
export const knowledgeWriteMethods = {
  "proposal.list": entry(
    object({
      projectId: Type.Optional(Id),
      state: Type.Optional(values(["pending", "accepted", "rejected"])),
    }),
    object({ items: Type.Array(KnowledgeProposalSchema), cursor: OptionalText }),
  ),
  "proposal.decide": entry(
    object({
      id: Id,
      decision: values(["accept", "reject"]),
      reason: OptionalText,
      /** Edit before accepting. */
      title: OptionalText,
      body: Type.Optional(Type.String({ minLength: 1, maxLength: 1200 })),
      /** Rescope before accepting. */
      scope: Type.Optional(ScopeSchema),
    }),
    ok,
  ),
  "knowledge.agentWrites": entry(
    object({
      projectId: Type.Optional(Id),
      since: Type.Optional(At),
      includeUser: Type.Optional(Type.Boolean()),
    }),
    object({ items: Type.Array(KnowledgeItemSchema) }),
  ),
  "knowledge.confirm": entry(
    object({ id: Id, expectedRevision: Type.Integer({ minimum: 1 }) }),
    KnowledgeItemSchema,
  ),
  "knowledge.revert": entry(
    object({ id: Id, expectedRevision: Type.Integer({ minimum: 1 }), confirmed: Type.Boolean() }),
    KnowledgeItemSchema,
  ),
  "knowledge.writes": entry(
    object({ taskId: Type.Optional(Id), threadId: Type.Optional(Id) }),
    object({
      writes: Type.Array(KnowledgeWriteRecordSchema),
      taint: Type.Array(SessionTaintSchema),
    }),
  ),
};
