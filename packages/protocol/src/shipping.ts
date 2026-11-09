import { type Static, Type } from "@sinclair/typebox";
import { At, Id, Json, object, values } from "./common.js";

const Short = Type.String({ maxLength: 2000 });
const Sha = Type.String({ pattern: "^[a-f0-9]{40,64}$", examples: ["a".repeat(40)] });
export const ShippingCheckSchema = object({
  id: Id,
  name: Short,
  state: Short,
  sha: Type.String({ maxLength: 64 }),
  url: Type.String({ maxLength: 2048 }),
  required: Type.Optional(Type.Boolean()),
});
export const ShippingThreadSchema = object({
  id: Id,
  author: Short,
  path: Short,
  line: Type.Optional(Type.Integer()),
  body: Type.String({ maxLength: 16000 }),
  diff: Type.Optional(Type.String({ maxLength: 12000 })),
  url: Type.String({ maxLength: 2048 }),
  resolved: Type.Boolean(),
  outdated: Type.Boolean(),
  kind: values(["thread", "review", "comment"]),
});
export const ShippingSnapshotSchema = object({
  number: Type.Integer({ minimum: 1 }),
  nodeId: Id,
  repositoryId: Id,
  url: Type.String({ maxLength: 2048 }),
  title: Short,
  state: values(["OPEN", "CLOSED", "MERGED"]),
  draft: Type.Boolean(),
  head: Sha,
  base: Sha,
  headBranch: Short,
  baseBranch: Short,
  headRepository: Short,
  queuePosition: Type.Optional(Type.Integer({ minimum: 1 })),
  mergeable: Short,
  mergeState: Short,
  reviewDecision: Short,
  canPush: Type.Boolean(),
  canMerge: Type.Boolean(),
  mergeMethods: Type.Array(values(["MERGE", "SQUASH", "REBASE"])),
  checks: Type.Array(ShippingCheckSchema, { maxItems: 200 }),
  threads: Type.Array(ShippingThreadSchema, { maxItems: 200 }),
  complete: Type.Boolean(),
  requirementsKnown: Type.Boolean(),
  fetchedAt: At,
});
export type ShippingSnapshot = Static<typeof ShippingSnapshotSchema>;
export type ShippingCheck = Static<typeof ShippingCheckSchema>;
export type ShippingThread = Static<typeof ShippingThreadSchema>;
export const ShippingSchema = object({
  id: Id,
  taskId: Id,
  repository: Type.String({
    pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    examples: ["example/repository"],
  }),
  account: Id,
  repositoryId: Id,
  remote: Short,
  remoteUrl: Short,
  branch: Short,
  baseBranch: Short,
  publishedHead: Type.Optional(Sha),
  snapshot: Type.Optional(ShippingSnapshotSchema),
  error: Type.Optional(Short),
  readOnly: Type.Boolean(),
  updatedAt: At,
});
export type Shipping = Static<typeof ShippingSchema>;
export const ShippingOperationSchema = object({
  id: Id,
  taskId: Id,
  kind: values(["publish", "merge"]),
  state: values([
    "awaiting_approval",
    "approved",
    "pushing",
    "pushed",
    "creating",
    "merging",
    "done",
    "uncertain",
    "failed",
  ]),
  fingerprint: Id,
  creationStarted: Type.Optional(Type.Boolean()),
  proposal: Json,
  result: Type.Optional(Json),
  updatedAt: At,
});
export type ShippingOperation = Static<typeof ShippingOperationSchema>;
export const ShippingFeedbackSchema = object({
  id: Id,
  taskId: Id,
  head: Sha,
  revision: Type.Integer({ minimum: 1 }),
  state: values(["queued", "delivered", "held", "cancelled"]),
  sources: Type.Array(object({ id: Id, hash: Id }), { maxItems: 20 }),
  text: Type.String({ maxLength: 16000 }),
  deliveredRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  reason: Type.Optional(Short),
  updatedAt: At,
});
export type ShippingFeedback = Static<typeof ShippingFeedbackSchema>;
const task = { id: Id };
const publish = {
  ...task,
  remote: Type.String({ minLength: 1, maxLength: 200 }),
  branch: Type.String({ minLength: 1, maxLength: 200 }),
  baseBranch: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  body: Type.String({ maxLength: 16000 }),
  draft: Type.Boolean(),
};
const feedback = {
  ...task,
  selected: Type.Array(Id, { minItems: 1, maxItems: 20 }),
  note: Type.String({ maxLength: 2000 }),
};
const method = <T extends import("@sinclair/typebox").TSchema>(params: T) => ({
  params,
  result: Json,
});
export const shippingMethods = {
  "shipping.setup": method(object(task)),
  "shipping.get": method(object(task)),
  "shipping.refresh": method(object(task)),
  "shipping.linkPreview": method(object({ ...task, url: Type.String({ maxLength: 2048 }) })),
  "shipping.link": method(object({ ...task, fingerprint: Id, confirmed: Type.Boolean() })),
  "shipping.publishPreview": method(object(publish)),
  "shipping.publish": method(object({ ...task, fingerprint: Id, confirmed: Type.Boolean() })),
  "shipping.diagnostics": method(object({ ...task, checkId: Id })),
  "shipping.feedbackPreview": method(object(feedback)),
  "shipping.feedback": method(object({ ...task, fingerprint: Id, confirmed: Type.Boolean() })),
  "shipping.cancelFeedback": method(object({ ...task, batchId: Id, confirmed: Type.Boolean() })),
  "shipping.mergePreview": method(
    object({ ...task, method: values(["MERGE", "SQUASH", "REBASE"]) }),
  ),
  "shipping.merge": method(object({ ...task, fingerprint: Id, confirmed: Type.Boolean() })),
};
export const shippingMacOnlyMethods = [
  "shipping.setup",
  "shipping.linkPreview",
  "shipping.link",
  "shipping.publishPreview",
  "shipping.publish",
  "shipping.feedbackPreview",
  "shipping.feedback",
  "shipping.cancelFeedback",
  "shipping.mergePreview",
  "shipping.merge",
] as const;
