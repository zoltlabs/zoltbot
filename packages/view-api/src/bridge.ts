import { type Static, Type } from "@sinclair/typebox";
import { At, Id, OptionalText, object, values } from "@zoltbot/protocol";
import { PermissionSchema, ViewVersionSchema } from "./manifest.js";
import { TopicSchema } from "./topics.js";

export const bridgeLimits = { bytes: 256 * 1024, callsPerSecond: 50, topicIntervalMs: 100 };
export const ThemeSchema = object({
  scheme: values(["light", "dark"]),
  tokens: Type.Record(Type.String(), Type.String()),
  fontSans: Type.String(),
  fontMono: Type.String(),
  fontScale: Type.Number({ minimum: 0 }),
});
export type Theme = Static<typeof ThemeSchema>;
export const appKeys = ["mod+k", "mod+b", "mod+i", "mod+j", "mod+,", "escape-exit"] as const;
const callId = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const ViewMessageSchema = Type.Union([
  object({ t: Type.Literal("hello"), api: Type.Literal(1) }),
  object({
    t: Type.Literal("call"),
    id: callId,
    method: Type.String({ maxLength: 80 }),
    params: Type.Optional(Type.Unknown()),
  }),
  object({
    t: Type.Literal("sub"),
    topics: Type.Array(TopicSchema, { maxItems: 5, uniqueItems: true }),
  }),
  object({
    t: Type.Literal("unsub"),
    topics: Type.Array(TopicSchema, { maxItems: 5, uniqueItems: true }),
  }),
  object({ t: Type.Literal("key"), combo: values(appKeys) }),
  object({ t: Type.Literal("pong"), id: callId }),
]);
export type ViewMessage = Static<typeof ViewMessageSchema>;
export const ReadySchema = object({
  t: Type.Literal("ready"),
  api: Type.Literal(1),
  view: object({ id: Id, name: Type.String(), version: ViewVersionSchema }),
  granted: Type.Array(PermissionSchema),
  theme: ThemeSchema,
  locale: Type.String(),
  reducedMotion: Type.Boolean(),
  mock: Type.Boolean(),
});
export const errorCodes = [
  "not_granted",
  "declined",
  "not_found",
  "stale",
  "invalid",
  "rate_limited",
  "unavailable",
] as const;
export const HostMessageSchema = Type.Union([
  ReadySchema,
  object({
    t: Type.Literal("result"),
    id: callId,
    ok: Type.Literal(true),
    value: Type.Optional(Type.Unknown()),
  }),
  object({
    t: Type.Literal("result"),
    id: callId,
    ok: Type.Literal(false),
    error: object({ code: values(errorCodes), message: Type.String() }),
  }),
  object({ t: Type.Literal("data"), topic: TopicSchema, value: Type.Unknown(), at: At }),
  object({
    t: Type.Literal("event"),
    name: values(["theme", "grants", "shortcut", "visibility"]),
    value: Type.Unknown(),
  }),
  object({ t: Type.Literal("ping"), id: callId }),
]);
export type HostMessage = Static<typeof HostMessageSchema>;
const chatIds = Type.Array(Id, { minItems: 1, maxItems: 50, uniqueItems: true });
export const callSchemas = {
  "chats.send": object({ chatIds, text: Type.String({ minLength: 1, maxLength: 8000 }) }),
  "chats.interrupt": object({ chatIds }),
  "requests.answer": object({
    requestId: Id,
    version: Type.Integer({ minimum: 1 }),
    choiceId: OptionalText,
    answers: Type.Optional(
      Type.Record(
        Id,
        Type.Union([Type.String(), Type.Array(Type.String()), object({ value: Type.Unknown() })]),
      ),
    ),
    feedback: OptionalText,
  }),
  "app.open": Type.Union([
    object({ chatId: Id }),
    object({ page: values(["needs-you", "overview", "settings"]) }),
  ]),
  "storage.get": object({}),
  "storage.set": object({ value: Type.Unknown() }),
};
