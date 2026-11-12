import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  AgentDefinitionSchema,
  AgentEventSchema,
  At,
  CommandActorSchema,
  ConnectionSchema,
  ContextPackSchema,
  Id,
  ItemSchema,
  object,
  ProfileSchema,
  ProjectSchema,
  parse,
  ResolutionSchema,
  ScopeSchema,
  TaskSchema,
  Text,
  ThreadSchema,
  UserInputSchema,
  values,
} from "@zoltbot/protocol";

export const runnerProtocolVersion = 1;
const nonnegative = Type.Integer({ minimum: 0 });
const seq = Type.Integer({ minimum: 1 });
const json = Type.Record(Text, Type.Unknown());
const connection = Type.Pick(ConnectionSchema, [
  "id",
  "version",
  "name",
  "projectId",
  "transport",
  "credentialReference",
  "posthog",
  "schemaTokens",
]);
export const LaunchManifestSchema = object({
  version: Type.Literal(1),
  id: Id,
  executionId: Id,
  threadId: Id,
  taskId: Type.Optional(Id),
  taskRevision: Type.Optional(seq),
  projectId: Type.Optional(Id),
  profileId: Id,
  configurationHash: Text,
  cwd: Text,
  browser: Type.Optional(json),
  artifact: Type.Optional(json),
  hostTools: Type.Optional(Type.Array(object({ name: Id, description: Text, inputSchema: json }))),
  baseCommit: Type.Optional(Text),
  connections: Type.Array(connection),
  skills: Type.Array(
    object({ id: Id, revision: seq, hash: Text, path: Text, wrapperTokens: nonnegative }),
  ),
  knowledge: Type.Optional(
    object({
      pack: Type.Optional(ContextPackSchema),
      scope: Type.Optional(ScopeSchema),
      scopeHash: Type.Optional(Text),
      packId: Id,
      text: Text,
      tokens: nonnegative,
    }),
  ),
  budget: object({
    limit: nonnegative,
    fixed: nonnegative,
    connections: nonnegative,
    skills: nonnegative,
    knowledge: nonnegative,
  }),
});
export const RunnerHelloSchema = object({
  acceptTasks: Type.Optional(Type.Boolean()),
  kind: values(["mac", "sandbox"]),
  runnerId: Id,
  protocolVersion: Type.Literal(runnerProtocolVersion),
  versions: Type.Record(Id, Text),
  clis: Type.Array(object({ id: Id, version: Text })),
  sleepKeepsProcesses: Type.Boolean(),
});
export const RunnerExecutionSchema = object({
  project: ProjectSchema,
  task: TaskSchema,
  thread: ThreadSchema,
  profile: ProfileSchema,
  definition: AgentDefinitionSchema,
  queuedItems: Type.Array(ItemSchema, { maxItems: 8 }),
  previousNativeId: Type.Optional(Id),
});
export const RunnerLeaseSchema = object({
  execution: Type.Optional(RunnerExecutionSchema),
  leaseId: Id,
  taskId: Id,
  brief: Text,
  actor: CommandActorSchema,
  launchManifest: LaunchManifestSchema,
  workspaceInstructions: Text,
});
export const RunnerEventSchema = object({
  sessionId: Type.Optional(Id),
  itemId: Type.Optional(Id),
  turnId: Type.Optional(Id),
  taskId: Id,
  leaseId: Id,
  runnerSeq: seq,
  event: AgentEventSchema,
});
export const RunnerAckSchema = object({ taskId: Id, runnerSeq: nonnegative });
export const RunnerCommandSchema = object({
  taskId: Id,
  leaseId: Id,
  commandId: Id,
  command: Type.Union([
    object({
      type: Type.Literal("send_turn"),
      inputId: Type.Optional(Id),
      input: UserInputSchema,
      mode: values(["queue", "steer"]),
    }),
    object({
      type: Type.Literal("answer_interaction"),
      interactionId: Id,
      version: Type.Optional(seq),
      answer: ResolutionSchema,
    }),
    object({ type: Type.Literal("interrupt"), turnId: Type.Optional(Id) }),
    object({ type: values(["stop", "collect_diff"]) }),
    object({
      type: Type.Literal("push_branch"),
      branch: Type.String({ minLength: 1, maxLength: 200 }),
    }),
  ]),
});
export const RunnerHeartbeatSchema = object({ runnerId: Id, leaseIds: Type.Array(Id), at: At });
export const RunnerDrainSchema = object({ runnerId: Id, reason: Text });
export const MacExecRequestSchema = object({
  requestId: Id,
  taskId: Id,
  turnId: Id,
  userId: Id,
  targetDeviceId: Id,
  command: Type.String({ minLength: 1, maxLength: 16000 }),
  cwd: Type.Optional(Text),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  stdin: Type.Optional(Type.String({ maxLength: 65536 })),
});
export const MacExecChunkSchema = object({
  requestId: Id,
  taskId: Id,
  chunkSeq: seq,
  stream: values(["stdout", "stderr"]),
  data: Type.String({ maxLength: 262144 }),
});
export const MacExecResultSchema = object({
  requestId: Id,
  taskId: Id,
  exitCode: Type.Integer(),
  stdout: Type.String({ maxLength: 262144 }),
  stderr: Type.String({ maxLength: 65536 }),
  truncated: Type.Boolean(),
  durationMs: nonnegative,
  mac: Text,
});
export const runnerMethods = {
  "runner.hello": RunnerHelloSchema,
  "runner.lease": RunnerLeaseSchema,
  "runner.event": RunnerEventSchema,
  "runner.ack": RunnerAckSchema,
  "runner.command": RunnerCommandSchema,
  "runner.heartbeat": RunnerHeartbeatSchema,
  "runner.drain": RunnerDrainSchema,
  "mac.exec.request": MacExecRequestSchema,
  "mac.exec.chunk": MacExecChunkSchema,
  "mac.exec.result": MacExecResultSchema,
};
const message = <M extends string, P extends TSchema>(method: M, params: P) =>
  object({
    jsonrpc: Type.Literal("2.0"),
    id: Type.Union([Id, Type.Integer()]),
    method: Type.Literal(method),
    params,
  });
export const RunnerRequestSchema = Type.Union(
  Object.entries(runnerMethods).map(([method, params]) => message(method, params)),
);
const responseId = Type.Union([Id, Type.Integer()]);
export const RunnerResultSchema = object({
  jsonrpc: Type.Literal("2.0"),
  id: responseId,
  result: Type.Unknown(),
});
export const RunnerErrorSchema = object({
  jsonrpc: Type.Literal("2.0"),
  id: responseId,
  error: object({ code: Type.Integer(), message: Text }),
});
export const RunnerMessageSchema = Type.Union([
  RunnerRequestSchema,
  RunnerResultSchema,
  RunnerErrorSchema,
]);
export type RunnerHello = Static<typeof RunnerHelloSchema>;
export type RunnerExecution = Static<typeof RunnerExecutionSchema>;
export type RunnerLease = Static<typeof RunnerLeaseSchema>;
export type RunnerEvent = Static<typeof RunnerEventSchema>;
export type RunnerCommand = Static<typeof RunnerCommandSchema>;
export type MacExecRequest = Static<typeof MacExecRequestSchema>;
export type MacExecResult = Static<typeof MacExecResultSchema>;
export function parseRunnerMessage(input: unknown) {
  return parse(RunnerMessageSchema, input);
}
