import { type Static, Type } from "@sinclair/typebox";
import { At, Id, Json, object, PermissionProfileSchema, Text, values } from "./common.js";

export const PhaseExecutionSchema = object({
  definitionId: Id,
  model: Text,
  effort: Type.Optional(Text),
  permissionCeiling: PermissionProfileSchema,
});
export const OrchestrationPhaseSchema = object({
  role: Text,
  instruction: Text,
  profileId: Id,
  execution: PhaseExecutionSchema,
  taskId: Type.Optional(Id),
  attempt: Type.Integer({ minimum: 1 }),
  status: values(["pending", "running", "passed", "blocked", "failed", "cancelled"]),
  summary: Type.Optional(Type.String({ maxLength: 2000 })),
});
export const OrchestrationSchema = object({
  routing: Type.Optional(object({ model: Text, usage: Type.Optional(Json) })),
  id: Id,
  threadId: Id,
  projectId: Id,
  brief: Type.String({ minLength: 1, maxLength: 4000 }),
  phases: Type.Array(OrchestrationPhaseSchema, { minItems: 1, maxItems: 8 }),
  state: values(["running", "blocked", "completed", "cancelled"]),
  revision: Type.Integer({ minimum: 1 }),
  workspaceId: Type.Optional(Id),
  createdAt: At,
  updatedAt: At,
});
export type Orchestration = Static<typeof OrchestrationSchema>;
export type OrchestrationPhase = Static<typeof OrchestrationPhaseSchema>;
const entry = <P extends import("@sinclair/typebox").TSchema>(params: P) => ({
  params,
  result: Json,
});
export const orchestrationMethods = {
  "orchestration.cancel": entry(object({ id: Id, revision: Type.Integer({ minimum: 1 }) })),
  "orchestration.retry": entry(object({ id: Id, revision: Type.Integer({ minimum: 1 }) })),
  "orchestration.repair": entry(object({ id: Id, revision: Type.Integer({ minimum: 1 }) })),
};
