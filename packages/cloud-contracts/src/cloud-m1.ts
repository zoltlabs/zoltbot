import { type Static, Type } from "@sinclair/typebox";
import {
  At,
  CloudRepositorySchema,
  CommandActorSchema,
  Id,
  object,
  TaskLocationSchema,
  Text,
  values,
} from "@zoltbot/protocol";

const timestamp = Type.Integer({ minimum: 0 });
export const CellTokenClaimsSchema = object({
  iss: Text,
  aud: Type.Literal("cell"),
  sub: Id,
  org: Id,
  device: Id,
  surface: CommandActorSchema.properties.surface,
  kind: values(["client", "mac_runner", "sandbox_runner"]),
  task: Type.Optional(Id),
  grant: Type.Optional(Id),
  session: Type.Optional(Id),
  iat: timestamp,
  exp: timestamp,
  jti: Id,
});
export type CellTokenClaims = Static<typeof CellTokenClaimsSchema>;
export const CellTokenRequestSchema = object({ orgId: Id, deviceId: Id });
export const CellTokenResultSchema = object({
  token: Type.String({ minLength: 1 }),
  cellUrl: Text,
  expiresAt: At,
});
export const CellJwkSchema = object({
  kty: Type.Literal("EC"),
  crv: Type.Literal("P-256"),
  use: Type.Literal("sig"),
  alg: Type.Literal("ES256"),
  kid: Id,
  x: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  y: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
});
export const CellJwksSchema = object({ keys: Type.Array(CellJwkSchema) });
export const CloudDeviceKeySchema = object({
  deviceId: Id,
  publicKey: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
});
export const CloudDeviceSchema = object({
  ...CloudDeviceKeySchema.properties,
  userId: Id,
  registeredAt: At,
  revokedAt: Type.Optional(At),
});
export const CloudSecretNameSchema = values(["anthropic", "openai", "github"]);
export const CloudSecretWriteSchema = object({
  value: Type.String({ minLength: 1, maxLength: 65536 }),
});
export const OrchestratorClaimsSchema = object({
  iss: Text,
  aud: Type.Literal("orchestrator"),
  sub: Id,
  org: Id,
  iat: timestamp,
  exp: timestamp,
  jti: Id,
});
export const SandboxCreateSchema = object({
  orgId: Id,
  userId: Id,
  projectId: Id,
  taskId: Id,
  ...CloudRepositorySchema.properties,
  provider: values(["claude", "codex"]),
});
export const SandboxOperationSchema = object({ orgId: Id, taskId: Id, sandboxId: Id });
export const SandboxRecordSchema = object({
  expiresAt: Type.Optional(At),
  orgId: Id,
  userId: Id,
  taskId: Id,
  sandboxId: Id,
  target: Type.Literal("e2b"),
  state: values(["creating", "running", "sleeping", "destroyed", "failed"]),
  sleepKeepsProcesses: Type.Boolean(),
  createdAt: At,
  updatedAt: At,
});
export const UsageOperationSchema = object({
  orgId: Id,
  taskId: Id,
  sandboxId: Id,
  operationId: Id,
  operation: values(["create", "wake", "sleep", "destroy"]),
  at: At,
});
export const CloudTaskLocationSchema = TaskLocationSchema;
export type SandboxCreate = Static<typeof SandboxCreateSchema>;
export type SandboxRecord = Static<typeof SandboxRecordSchema>;
export type CloudDevice = Static<typeof CloudDeviceSchema>;

export const CloudRunnerGrantInputSchema = object({
  deviceId: Id,
  canRunTasks: Type.Boolean(),
  canMacExec: Type.Boolean(),
});
export const CloudRunnerGrantSchema = object({
  ...CloudRunnerGrantInputSchema.properties,
  id: Id,
  sessionId: Id,
  expiresAt: At,
});
export const CloudRunnerGrantResultSchema = object({
  grant: Type.Union([CloudRunnerGrantSchema, Type.Null()]),
});
export const CloudRunnerGrantListSchema = object({ grants: Type.Array(CloudRunnerGrantSchema) });
export type CloudRunnerGrant = Static<typeof CloudRunnerGrantSchema>;

/** The opaque worker refresh capability belongs only in its authorization header. */
export const WorkerTokenRequestSchema = object({ orgId: Id, taskId: Id, runnerId: Id });
