import { type Static, Type } from "@sinclair/typebox";
import {
  At,
  Id,
  Json,
  object,
  PermissionProfileSchema,
  ScopeSchema,
  Text,
  values,
} from "./common.js";

export const InitiativeRecordSchema = object({
  id: Id,
  projectId: Id,
  teamId: Type.Optional(Id),
  title: Text,
  outcome: Text,
  acceptance: Text,
  managerThreadId: Type.Optional(Id),
  priority: values(["low", "normal", "high", "urgent"]),
  state: values(["proposed", "active", "paused", "review", "completed", "cancelled"]),
  targetDate: Type.Optional(At),
  constraints: Text,
  knowledgeIds: Type.Array(Id),
  budgetUsd: Type.Optional(Type.Number({ minimum: 0 })),
  version: Type.Integer({ minimum: 1 }),
  createdAt: At,
  updatedAt: At,
});
export type InitiativeRecord = Static<typeof InitiativeRecordSchema>;
export const ManagerRemitSchema = object({
  id: Id,
  projectId: Id,
  threadId: Id,
  responsibilities: Text,
  capabilities: Text,
  boundaries: Text,
  escalation: Text,
  version: Type.Integer({ minimum: 1 }),
  updatedAt: At,
});
export type ManagerRemit = Static<typeof ManagerRemitSchema>;
const taskInput = object({
  id: Id,
  title: Text,
  brief: Text,
  acceptance: Type.Optional(Text),
  profileId: Id,
  node: ScopeSchema,
  initiativeId: Type.Optional(Id),
  accountableThreadId: Type.Optional(Id),
  parentId: Type.Optional(Id),
  dependencies: Type.Optional(Type.Array(Id)),
  planned: Type.Optional(Type.Boolean()),
  budgetUsd: Type.Optional(Type.Number({ minimum: 0 })),
});
export const CompanyChangeSchema = Type.Union([
  object({ kind: Type.Literal("assignManager"), id: Id, parent: ScopeSchema, why: Text }),
  object({
    kind: Type.Literal("moveTask"),
    id: Id,
    initiativeId: Type.Optional(Id),
    accountableThreadId: Type.Optional(Id),
    why: Text,
  }),
  object({ kind: Type.Literal("team"), id: Id, name: Text, parent: ScopeSchema, why: Text }),
  object({
    kind: Type.Literal("chat"),
    id: Id,
    title: Text,
    parent: ScopeSchema,
    profileId: Id,
    manager: Type.Boolean(),
    why: Text,
  }),
  object({ kind: Type.Literal("initiative"), value: InitiativeRecordSchema, why: Text }),
  object({ kind: Type.Literal("remit"), value: ManagerRemitSchema, why: Text }),
  object({ kind: Type.Literal("task"), value: taskInput, why: Text }),
  object({ kind: Type.Literal("moveTeam"), id: Id, parent: ScopeSchema, why: Text }),
  object({ kind: Type.Literal("renameTeam"), id: Id, name: Text, why: Text }),
  object({ kind: Type.Literal("archiveTeam"), id: Id, why: Text }),
  object({ kind: Type.Literal("moveChat"), id: Id, parent: ScopeSchema, why: Text }),
  object({ kind: Type.Literal("assignTask"), id: Id, accountableThreadId: Id, why: Text }),
  object({ kind: Type.Literal("releaseTask"), id: Id, why: Text }),
]);
export type CompanyChange = Static<typeof CompanyChangeSchema>;
export const CompanyPlanSchema = object({
  id: Id,
  projectId: Id,
  title: Text,
  explanation: Text,
  version: Type.Integer({ minimum: 1 }),
  state: values(["proposed", "applied", "declined"]),
  changes: Type.Array(CompanyChangeSchema, { minItems: 1, maxItems: 50 }),
  baseline: Text,
  preview: Type.Array(object({ change: CompanyChangeSchema, before: Json, after: Json })),
  requestedBy: Id,
  approvedBy: Type.Optional(Id),
  approvedAt: Type.Optional(At),
  authority: Type.Optional(
    object({
      initiativeId: Id,
      maxTasks: Type.Integer({ minimum: 1, maximum: 100 }),
      reviewTasks: Type.Optional(Type.Boolean()),
      permissionCeiling: PermissionProfileSchema,
      budgetUsd: Type.Number({ minimum: 0 }),
    }),
  ),
  createdAt: At,
});
export type CompanyPlan = Static<typeof CompanyPlanSchema>;
export const ProjectBriefSchema = object({
  id: Id,
  projectId: Id,
  day: Text,
  revision: Type.Integer({ minimum: 1 }),
  summary: Text,
  evidence: Json,
  createdAt: At,
});
export type ProjectBrief = Static<typeof ProjectBriefSchema>;
export const companyMethods = {
  "company.review": {
    params: object({
      taskId: Id,
      revision: Type.Integer({ minimum: 1 }),
      decision: values(["accept", "changes", "reject"]),
      feedback: Type.Optional(Text),
      planId: Type.Optional(Id),
    }),
    result: Json,
  },
  "company.read": { params: object({ projectId: Type.Optional(Id) }), result: Json },
  "company.propose": {
    params: object({
      id: Id,
      projectId: Id,
      title: Text,
      explanation: Text,
      changes: Type.Array(CompanyChangeSchema, { minItems: 1, maxItems: 50 }),
      authority: Type.Optional(CompanyPlanSchema.properties.authority),
    }),
    result: CompanyPlanSchema,
  },
  "company.decide": {
    params: object({
      id: Id,
      version: Type.Integer({ minimum: 1 }),
      baseline: Text,
      approve: Type.Boolean(),
    }),
    result: Json,
  },
  "company.assign": {
    params: object({ value: taskInput, planId: Type.Optional(Id) }),
    result: Json,
  },
  "company.brief": {
    params: object({ projectId: Id, summary: Type.Optional(Text) }),
    result: ProjectBriefSchema,
  },
};
