import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { At, ItemSchema, parse } from "@zoltbot/protocol";
import {
  RunnerExecutionSchema,
  type RunnerLease,
  RunnerLeaseSchema,
} from "@zoltbot/runner-protocol";

function dates<T extends TSchema>(schema: T): T {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const result = { ...value } as Record<string, unknown>;
    if (result.pattern === At.pattern) result.default = "2026-11-11T00:00:00Z";
    for (const [key, item] of Object.entries(result)) result[key] = visit(item);
    return result;
  };
  return visit(schema) as T;
}

/** Synthetic wire assignment; no account, credentials, native CLI or network. */
export function runnerLease(location: "mac" | "sandbox" = "mac"): RunnerLease {
  const value = Value.Create(RunnerLeaseSchema);
  const execution = Value.Create(dates(RunnerExecutionSchema));
  execution.task = {
    ...execution.task,
    id: "task",
    threadId: "thread",
    projectId: "project",
    location,
    state: "running",
  };
  execution.thread.id = "thread";
  execution.thread.projectId = "project";
  execution.thread.taskId = "task";
  execution.thread.agentId = execution.profile.id;
  execution.task.ownerAgentId = execution.profile.id;
  execution.task.createdBy = { kind: "human", id: "member" };
  execution.profile.definitionId = execution.definition.id;
  execution.project.id = "project";
  execution.project.cloud = {
    repository: "example/repository",
    defaultBranch: "main",
    setupScript: "",
  };
  execution.queuedItems = [
    parse(ItemSchema, {
      id: "task:r1:input",
      threadId: "thread",
      seq: 1,
      kind: "user",
      body: {
        queueVersion: 1,
        queueState: "queued",
        input: [{ type: "text", text: "Synthetic task" }],
        mode: "queue",
        origin: "system",
      },
      createdAt: "2026-11-11T00:00:00Z",
      updatedAt: "2026-11-11T00:00:00Z",
    }),
  ];
  return parse(RunnerLeaseSchema, {
    ...value,
    taskId: "task",
    leaseId: "lease",
    actor: { userId: "member", deviceId: "runner", surface: "runner" },
    execution,
    launchManifest: {
      ...value.launchManifest,
      taskId: "task",
      threadId: "thread",
      projectId: "project",
      profileId: execution.profile.id,
      taskRevision: execution.task.revision,
    },
  });
}
