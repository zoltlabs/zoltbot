import { type Static, Type } from "@sinclair/typebox";
import { At, Id, object, parse } from "@zoltbot/protocol";

const commit = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const relativePath = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\u0000]+$",
});
const file = object({
  path: relativePath,
  previousPath: Type.Optional(relativePath),
  added: Type.Integer({ minimum: 0 }),
  removed: Type.Integer({ minimum: 0 }),
  binary: Type.Boolean(),
  patch: Type.String({ maxLength: 262144 }),
  unavailable: Type.Optional(Type.String({ maxLength: 2000 })),
});

/** Review content belongs to exactly one task revision, never a caller-selected checkout. */
export const RunnerDiffResultSchema = object({
  taskId: Id,
  revision: Type.Integer({ minimum: 1 }),
  base: commit,
  head: commit,
  patch: Type.String({ maxLength: 524288 }),
  status: Type.String({ maxLength: 65536 }),
  paths: Type.Array(relativePath, { maxItems: 200 }),
  files: Type.Array(file, { maxItems: 200 }),
  uncommittedFiles: Type.Array(file, { maxItems: 200 }),
  provenance: Type.String({ maxLength: 2000 }),
  patchIncomplete: Type.Boolean(),
  capturedAt: At,
});
export const RunnerPushResultSchema = object({
  taskId: Id,
  revision: Type.Integer({ minimum: 1 }),
  repository: Type.String({
    minLength: 3,
    maxLength: 256,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$",
  }),
  branch: Type.String({ minLength: 1, maxLength: 200 }),
  head: commit,
  pushed: Type.Literal(true),
});
export const RunnerReviewPreviewSchema = object({
  taskId: Id,
  revision: Type.Integer({ minimum: 1 }),
  fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  head: commit,
  base: commit,
  files: Type.Array(
    object({
      path: relativePath,
      hash: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Literal("deleted")]),
      mode: Type.Optional(
        Type.Union([Type.Literal("100644"), Type.Literal("100755"), Type.Literal("120000")]),
      ),
      excluded: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    { maxItems: 200 },
  ),
});
export const RunnerReviewCommitSchema = object({
  taskId: Id,
  revision: Type.Integer({ minimum: 1 }),
  fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  head: commit,
  previous: commit,
  base: commit,
});
export const runnerResults = {
  review_preview: RunnerReviewPreviewSchema,
  review_commit: RunnerReviewCommitSchema,
  collect_diff: RunnerDiffResultSchema,
  push_branch: RunnerPushResultSchema,
};
export type RunnerDiffResult = Static<typeof RunnerDiffResultSchema>;
export type RunnerPushResult = Static<typeof RunnerPushResultSchema>;

/** Receivers must additionally check the authenticated lease, task revision and expected commit. */
export function parseRunnerCommandResult<K extends keyof typeof runnerResults>(
  kind: K,
  input: unknown,
): Static<(typeof runnerResults)[K]> {
  try {
    const encoded = JSON.stringify(input);
    if (!encoded || new TextEncoder().encode(encoded).byteLength > 1024 * 1024) throw new Error();
    return parse(runnerResults[kind], input);
  } catch {
    throw new Error("runner_result_invalid");
  }
}
