import { type Static, Type } from "@sinclair/typebox";
import { At, Id, object, Text, values } from "./common.js";

export const CommandActorSchema = object({
  userId: Id,
  deviceId: Id,
  surface: values(["desktop", "phone", "runner", "system"]),
});
export type CommandActor = Static<typeof CommandActorSchema>;
export function localCommandActor(deviceId?: string): CommandActor {
  return {
    userId: "local-owner",
    deviceId: deviceId ?? "local-mac",
    surface: deviceId ? "phone" : "desktop",
  };
}
export const TaskLocationSchema = values(["mac", "sandbox"]);
export const CloudRepositorySchema = object({
  repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 200 }),
  defaultBranch: Type.String({ minLength: 1, maxLength: 200 }),
  setupScript: Type.String({ maxLength: 64000 }),
});
export const CloudProjectCreateSchema = object({
  name: Type.String({ minLength: 1, maxLength: 150 }),
  ...CloudRepositorySchema.properties,
});
export const CloudUsageSchema = object({
  periodStart: At,
  periodEnd: At,
  sandboxSeconds: Type.Number({ minimum: 0 }),
  limitSeconds: Type.Number({ minimum: 0 }),
  tasks: Type.Array(object({ taskId: Id, sandboxSeconds: Type.Number({ minimum: 0 }) })),
});
export type CloudUsage = Static<typeof CloudUsageSchema>;
export const CloudProjectListParamsSchema = object({
  cursor: Type.Optional(Text),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
