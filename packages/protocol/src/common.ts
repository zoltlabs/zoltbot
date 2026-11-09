import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const protocolVersion = 1;
export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const values = <const T extends string>(items: readonly T[]) =>
  Type.Union(items.map((item) => Type.Literal(item)));
export const Id = Type.String({ minLength: 1, maxLength: 200 });
export const Text = Type.String();
export const At = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
});
export const OptionalText = Type.Optional(Text);
export const Strings = Type.Array(Text);
export const Json = Type.Unknown();
export const ActorSchema = object({ kind: values(["human", "agent", "system"]), id: Id });
export type ActorRef = Static<typeof ActorSchema>;
export const PermissionProfileSchema = values([
  "read_only",
  "workspace_write",
  "workspace_write_net",
  "full_access",
]);
export type PermissionProfile = Static<typeof PermissionProfileSchema>;
export const ScopeSchema = object({
  type: values(["user", "project", "subproject", "area", "initiative", "task"]),
  id: Id,
});
export type Scope = Static<typeof ScopeSchema>;
export const UserErrorSchema = object({ code: Id, message: Text, fix: OptionalText });
export const ToolKindSchema = values([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "mode",
  "agent",
  "other",
]);
export type ToolKind = Static<typeof ToolKindSchema>;
export const LocationSchema = object({
  path: Text,
  line: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const DiffSchema = object({
  path: Text,
  before: OptionalText,
  after: OptionalText,
  patch: OptionalText,
});
export const PlanEntrySchema = object({
  step: Text,
  status: values(["pending", "in_progress", "completed"]),
});
/** A long running shell command or agent started in the background by the provider. */
export const BackgroundTaskSchema = object({
  id: Id,
  kind: values(["shell", "agent", "other"]),
  description: Text,
  state: values(["running", "completed", "failed", "stopped"]),
  summary: OptionalText,
  outputPath: OptionalText,
  toolItemId: Type.Optional(Id),
  startedAt: Type.Optional(Text),
  endedAt: Type.Optional(Text),
});
export type BackgroundTask = Static<typeof BackgroundTaskSchema>;
export const UserInputSchema = Type.Array(
  Type.Union([
    object({ type: Type.Literal("text"), text: Text }),
    object({
      type: Type.Literal("image"),
      path: OptionalText,
      base64: OptionalText,
      mimeType: OptionalText,
    }),
    object({ type: Type.Literal("file"), path: Text }),
  ]),
  { minItems: 1 },
);
export type UserInput = Static<typeof UserInputSchema>;
export const UsageSampleSchema = object({
  inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  contextUsed: Type.Optional(Type.Integer({ minimum: 0 })),
  contextSize: Type.Optional(Type.Integer({ minimum: 1 })),
  cumulative: Type.Optional(Type.Boolean()),
});
export type UsageSample = Static<typeof UsageSampleSchema>;
export function parse<T extends TSchema>(schema: T, payload: unknown): Static<T> {
  if (Value.Check(schema, payload)) return payload;
  const errors = [...Value.Errors(schema, payload)].map((e) => `${e.path || "/"}: ${e.message}`);
  throw new Error(`Invalid payload: ${errors.slice(0, 10).join("; ")}`);
}
