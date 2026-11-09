import { type Static, Type } from "@sinclair/typebox";
import { Id, object, PermissionProfileSchema, Text, values } from "./common.js";

export const ForkBoundarySchema = Type.Union([
  object({ kind: Type.Literal("latest") }),
  object({ kind: values(["before_user", "after_turn"]), turnId: Id }),
]);
export type ForkBoundary = Static<typeof ForkBoundarySchema>;
export const NativeForkCapabilitiesSchema = object({
  latest: Type.Boolean(),
  boundaries: Type.Array(values(["before_user", "after_turn"])),
  callerId: Type.Boolean(),
  activation: values(["active", "load", "deferred"]),
  reason: Type.Optional(Text),
});
export type NativeForkCapabilities = Static<typeof NativeForkCapabilitiesSchema>;
export const ForkKindSchema = values(["native", "copied"]);
export type ForkKind = Static<typeof ForkKindSchema>;
export const ForkProvenanceSchema = object({
  kind: Type.Optional(ForkKindSchema),
  copiedMessages: Type.Optional(Type.Integer({ minimum: 0 })),
  omittedMessages: Type.Optional(Type.Integer({ minimum: 0 })),
  operationId: Id,
  sourceThreadId: Id,
  sourceSessionId: Id,
  sourceNativeId: Type.Optional(Id),
  sourceTaskId: Type.Optional(Id),
  workspaceId: Type.Optional(Id),
  cwd: Text,
  boundary: ForkBoundarySchema,
  permissionCeiling: PermissionProfileSchema,
  inheritedHistoryPresent: Type.Boolean(),
});
export type ForkProvenance = Static<typeof ForkProvenanceSchema>;
export const forkStates = [
  "requested",
  "dispatching",
  "native_created",
  "activating",
  "ready",
  "failed",
  "needs_reconciliation",
] as const;
export const ForkOperationSchema = object({
  kind: Type.Optional(ForkKindSchema),
  destinationProfileId: Type.Optional(Id),
  id: Id,
  sourceThreadId: Id,
  childThreadId: Id,
  boundary: ForkBoundarySchema,
  title: Text,
  state: values(forkStates),
  targetNativeId: Type.Optional(Id),
  error: Type.Optional(Text),
  createdAt: Text,
});
export type ForkOperation = Static<typeof ForkOperationSchema>;
/** Forks carry native history even before the child has any local turns. */
export function hasInheritedNativeHistory(thread: { fork?: unknown } | undefined): boolean {
  const fork = thread?.fork as Partial<ForkProvenance> | undefined;
  return fork?.inheritedHistoryPresent === true;
}
