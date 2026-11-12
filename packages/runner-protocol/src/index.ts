import { type Static, type TSchema, Type } from "@sinclair/typebox";

export * from "./command-results.js";

import {
  AgentDefinitionSchema,
  AgentEventSchema,
  At,
  CommandActorSchema,
  ConnectionSchema,
  ContextPackSchema,
  Id,
  ItemSchema,
  MacOutputChunkSchema,
  object,
  ProfileSchema,
  ProjectSchema,
  parse,
  ResolutionSchema,
  ScopeSchema,
  SignedMacApprovalSchema,
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
      nativeRef: Type.Optional(Id),
      version: Type.Optional(seq),
      answer: ResolutionSchema,
    }),
    object({ type: Type.Literal("interrupt"), turnId: Type.Optional(Id) }),
    object({ type: Type.Literal("stop") }),
    object({ type: Type.Literal("collect_diff"), revision: Type.Optional(seq) }),
    object({ type: Type.Literal("review_preview"), revision: seq }),
    object({
      type: Type.Literal("review_commit"),
      revision: seq,
      fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      head: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
      base: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
    }),
    object({
      type: Type.Literal("push_branch"),
      revision: seq,
      head: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
      previousHead: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" })),
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
  approval: Type.Optional(SignedMacApprovalSchema),
});
export const MacExecChunkSchema = MacOutputChunkSchema;
export const MacExecResultSchema = object({
  requestId: Id,
  taskId: Id,
  exitCode: Type.Integer(),
  stdout: Type.String({ maxLength: 262144 }),
  stderr: Type.String({ maxLength: 65536 }),
  truncated: Type.Boolean(),
  durationMs: nonnegative,
  mac: Text,
  stdoutBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  stderrBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
export const MacStatusRequestSchema = object({
  requestId: Id,
  taskId: Id,
  turnId: Id,
  userId: Id,
  targetDeviceId: Type.Optional(Id),
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
});
export const MacStatusResultSchema = Type.Union([
  object({
    available: Type.Literal(false),
    reason: values(["offline", "off", "unavailable", "choose_mac"]),
  }),
  object({
    available: Type.Literal(true),
    targetDeviceId: Id,
    mac: Text,
    osVersion: Text,
    allowListedCommands: Type.Optional(Type.Boolean()),
    cwd: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
  }),
]);
/** A repeated exec request reads durable progress; it never grants a second execution. */
export const MacExecProgressSchema = Type.Union([
  object({ state: Type.Literal("pending"), requestId: Id, interactionId: Id }),
  object({ state: Type.Literal("running"), requestId: Id }),
  object({ state: Type.Literal("complete"), requestId: Id, result: MacExecResultSchema }),
  object({
    state: Type.Literal("denied"),
    requestId: Id,
    reason: values(["declined", "expired", "offline", "failed"]),
  }),
]);
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
  "mac.status.request": MacStatusRequestSchema,
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
export type MacExecChunk = Static<typeof MacExecChunkSchema>;
export type MacStatusRequest = Static<typeof MacStatusRequestSchema>;
export type MacStatusResult = Static<typeof MacStatusResultSchema>;
export type MacExecProgress = Static<typeof MacExecProgressSchema>;
export function parseRunnerMessage(input: unknown) {
  return parse(RunnerMessageSchema, input);
}
