import { type Static, Type } from "@sinclair/typebox";
import { At, Id, object, values } from "./common.js";

const Text = Type.String({ minLength: 1, maxLength: 200 });
const Repository = Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 200 });
export const WakeConditionSchema = Type.Union([
  object({
    kind: Type.Literal("job"),
    sessionId: Id,
    jobId: Id,
    outcome: values(["finished", "passed"]),
  }),
  object({ kind: Type.Literal("task"), taskId: Id, outcome: values(["finished", "passed"]) }),
  object({ kind: Type.Literal("turn"), turnId: Id, outcome: values(["finished", "passed"]) }),
  object({
    kind: Type.Literal("pr"),
    repository: Repository,
    number: Type.Integer({ minimum: 1 }),
    repositoryId: Type.Optional(Id),
    accountId: Type.Optional(Id),
  }),
  object({
    kind: Type.Literal("ci"),
    repository: Repository,
    runId: Type.String({ pattern: "^[0-9]+$" }),
    attempt: Type.Integer({ minimum: 1 }),
    outcome: values(["finished", "passed"]),
    repositoryId: Type.Optional(Id),
    accountId: Type.Optional(Id),
  }),
  object({
    kind: Type.Literal("topic"),
    projectId: Id,
    phrase: Type.String({ minLength: 2, maxLength: 200 }),
  }),
]);
export const WakeInputSchema = object({
  threadId: Id,
  condition: WakeConditionSchema,
  fallbackAt: At,
  behavior: values(["inbox", "resume"]),
  continuation: Type.String({ maxLength: 2400 }),
});
export const WakeSchema = object({
  ...WakeInputSchema.properties,
  id: Id,
  label: Text,
  permissionStamp: Type.Optional(Type.String({ maxLength: 4000 })),
  revision: Type.Integer({ minimum: 1 }),
  status: values([
    "draft",
    "waiting",
    "ready",
    "queued",
    "consumed",
    "cancelled",
    "needs_attention",
  ]),
  createdAt: At,
  updatedAt: At,
  armedAt: Type.Optional(At),
  lastCheckedAt: Type.Optional(At),
  error: Type.Optional(Text),
  reason: Type.Optional(Text),
  evidenceUrl: Type.Optional(Type.String({ maxLength: 1000 })),
  itemId: Type.Optional(Id),
});
export type Wake = Static<typeof WakeSchema>;
export type WakeInput = Static<typeof WakeInputSchema>;
export type WakeCondition = Static<typeof WakeConditionSchema>;
const revision = object({ id: Id, revision: Type.Integer({ minimum: 1 }) });
export const wakeMethods = {
  "wake.save": {
    params: object({
      input: WakeInputSchema,
      id: Type.Optional(Id),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    result: WakeSchema,
  },
  "wake.cancel": { params: revision, result: WakeSchema },
  "wake.resumeNow": { params: revision, result: WakeSchema },
};
export function wakeLabel(c: WakeCondition): string {
  switch (c.kind) {
    case "job":
      return `Job ${c.jobId} ${c.outcome === "passed" ? "succeeds" : "finishes"}`;
    case "task":
      return `Task ${c.taskId} ${c.outcome === "passed" ? "completes successfully" : "finishes"}`;
    case "turn":
      return `Chat turn ${c.turnId} ${c.outcome === "passed" ? "completes successfully" : "finishes"}`;
    case "pr":
      return `${c.repository}#${c.number} merges`;
    case "ci":
      return `${c.repository} run ${c.runId}, attempt ${c.attempt} ${c.outcome === "passed" ? "passes" : "finishes"}`;
    case "topic":
      return `You mention “${c.phrase}” in this workspace`;
  }
}
