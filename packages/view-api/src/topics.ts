import { type Static, Type } from "@sinclair/typebox";
import { At, Id, OptionalText, object, values } from "@zoltbot/protocol";

export const TopicSchema = values(["chats", "requests", "workspaces", "usage", "checks"]);
export type Topic = Static<typeof TopicSchema>;
const number = Type.Number({ minimum: 0 });
const tokens = { inputTokens: number, outputTokens: number };
export const ChatSchema = object({
  id: Id,
  title: Type.String(),
  kind: values(["main", "task", "side", "manager"]),
  status: values(["needs_you", "working", "review", "later", "settled", "idle"]),
  problem: Type.Optional(
    object({
      kind: values(["auth_required", "rate_limited", "error", "reconnecting"]),
      detail: OptionalText,
    }),
  ),
  lastTurn: Type.Optional(
    object({
      status: values(["running", "completed", "failed", "interrupted"]),
      endedAt: Type.Optional(At),
    }),
  ),
  activity: OptionalText,
  profile: object({ id: Id, name: Type.String() }),
  provider: object({ id: Id, name: Type.String() }),
  workspaceId: Type.Optional(Id),
  worktree: Type.Optional(
    object({
      id: Id,
      kind: values(["folder", "worktree"]),
      branch: OptionalText,
      baseRef: OptionalText,
    }),
  ),
  parentChatId: Type.Optional(Id),
  requestIds: Type.Array(Id),
  startedAt: At,
  updatedAt: At,
  usage: object({ costUsd: Type.Optional(number), ...tokens }),
});
export type Chat = Static<typeof ChatSchema>;
export const RequestSchema = object({
  id: Id,
  version: Type.Integer({ minimum: 1 }),
  chatId: Id,
  type: values(["approval", "question", "plan", "form", "gate"]),
  title: Type.String(),
  urgency: values(["blocking", "background"]),
  createdAt: At,
  context: Type.Optional(
    object({ markdown: OptionalText, tool: OptionalText, command: OptionalText }),
  ),
  choices: Type.Array(object({ id: Id, label: Type.String(), widens: Type.Boolean() })),
  answerInChat: Type.Optional(Type.Boolean()),
  questions: Type.Optional(
    Type.Array(
      object({
        id: Id,
        label: Type.String(),
        options: Type.Optional(Type.Array(object({ id: Id, label: Type.String() }))),
        freeText: Type.Boolean(),
        multi: Type.Optional(Type.Boolean()),
        schema: Type.Optional(Type.Unknown()),
      }),
    ),
  ),
});
export type Request = Static<typeof RequestSchema>;
export const WorkspaceSchema = object({
  id: Id,
  name: Type.String(),
  roots: Type.Array(object({ label: Type.String(), isRepository: Type.Boolean() })),
});
export type Workspace = Static<typeof WorkspaceSchema>;
export const UsageSchema = object({
  today: object({ costUsd: number, costKnown: Type.Boolean(), ...tokens }),
  budget: Type.Optional(object({ limitUsd: number, period: Type.Literal("day") })),
  activeChats: Type.Integer({ minimum: 0 }),
});
export type Usage = Static<typeof UsageSchema>;
export const CheckSchema = object({
  chatId: Id,
  name: Type.String(),
  state: values(["pending", "passing", "failing", "skipped"]),
  required: Type.Boolean(),
});
export type Check = Static<typeof CheckSchema>;
export const topicSchemas = {
  chats: Type.Array(ChatSchema),
  requests: Type.Array(RequestSchema),
  workspaces: Type.Array(WorkspaceSchema),
  usage: UsageSchema,
  checks: Type.Array(CheckSchema),
};
export type TopicValues = { [K in keyof typeof topicSchemas]: Static<(typeof topicSchemas)[K]> };
