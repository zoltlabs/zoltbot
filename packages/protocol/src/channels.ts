import { type Static, Type } from "@sinclair/typebox";
import { At, Id, object, values } from "./common.js";

/** Longest post a person or an agent can make in a channel. */
export const channelPostLimit = 4000;
const PostText = Type.String({ minLength: 1, maxLength: channelPostLimit });
const Name = Type.String({ minLength: 1, maxLength: 80 });

/**
 * A team's group conversation: the owner, its lead and its members. The daemon creates one for
 * each team with a manager (led by that manager) and one for each project with a CEO (led by
 * the CEO), and keeps the members in step with the team. Agents keep working in their own chats;
 * a channel is where they post and read.
 */
export const ChannelSchema = object({
  id: Id,
  projectId: Id,
  /** Absent for the project-wide channel. */
  teamId: Type.Optional(Id),
  kind: values(["team", "project"]),
  name: Name,
  leadThreadId: Id,
  /** Every member chat, the lead included. */
  memberThreadIds: Type.Array(Id, { maxItems: 200 }),
  createdAt: At,
  updatedAt: At,
  /** Set while the team has no manager or the project no CEO. The transcript stays readable. */
  archivedAt: Type.Optional(At),
});
export type Channel = Static<typeof ChannelSchema>;

export const ChannelAuthorSchema = Type.Union([
  object({ kind: Type.Literal("owner") }),
  object({ kind: Type.Literal("thread"), threadId: Id }),
]);
export type ChannelAuthor = Static<typeof ChannelAuthorSchema>;

/**
 * One line of a channel's transcript. Delivery stays on the single messaging path: each
 * recipient gets an ordinary message (listed in `messageIds`) that carries the channel id.
 */
export const ChannelPostSchema = object({
  id: Id,
  channelId: Id,
  projectId: Id,
  author: ChannelAuthorSchema,
  text: PostText,
  /** Member chats the post @mentions. */
  mentions: Type.Array(Id, { maxItems: 32 }),
  /** Member chats it was delivered to: its mentions, else the lead. */
  recipients: Type.Array(Id, { maxItems: 32 }),
  messageIds: Type.Array(Id, { maxItems: 32 }),
  requestId: Type.Optional(Id),
  /** The post this one answers. */
  replyTo: Type.Optional(Id),
  /** True when the recipients owe a reply: owner posts and agent questions. */
  question: Type.Boolean(),
  createdAt: At,
});
export type ChannelPost = Static<typeof ChannelPostSchema>;

export const ChannelRequestStateSchema = values(["open", "running", "done", "stopped", "archived"]);
export type ChannelRequestState = Static<typeof ChannelRequestStateSchema>;
/**
 * Each owner post starts a request owned by the channel's lead. Tasks the lead assigns while
 * handling it carry its id, so Stop cancels exactly those tasks.
 */
export const ChannelRequestSchema = object({
  id: Id,
  channelId: Id,
  projectId: Id,
  postId: Id,
  title: Type.String({ minLength: 1, maxLength: 120 }),
  leadThreadId: Id,
  state: ChannelRequestStateSchema,
  /** The state to go back to on Restore. */
  archivedFrom: Type.Optional(values(["open", "running", "done", "stopped"])),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: At,
  updatedAt: At,
});
export type ChannelRequest = Static<typeof ChannelRequestSchema>;

/** A task a lead assigned while handling one of the channel's requests. */
export const ChannelTaskSchema = object({
  id: Id,
  requestId: Id,
  title: Type.String(),
  state: Type.String(),
  threadId: Type.Optional(Id),
  createdAt: At,
  updatedAt: At,
});
/** A question still waiting for a member's answer. */
export const ChannelWaitingSchema = object({
  postId: Id,
  threadId: Id,
  askedBy: ChannelAuthorSchema,
  since: At,
});
export type ChannelWaiting = Static<typeof ChannelWaitingSchema>;
export const ChannelReadSchema = object({
  channel: ChannelSchema,
  posts: Type.Array(ChannelPostSchema),
  requests: Type.Array(ChannelRequestSchema),
  tasks: Type.Array(ChannelTaskSchema),
  waiting: Type.Array(ChannelWaitingSchema),
  /** True when older posts were left out. */
  more: Type.Boolean(),
});
export type ChannelRead = Static<typeof ChannelReadSchema>;

export const ChannelRequestActionSchema = values([
  "stop",
  "resume",
  "reassign",
  "archive",
  "restore",
]);
export type ChannelRequestAction = Static<typeof ChannelRequestActionSchema>;

export const channelMethods = {
  "channel.list": {
    params: object({ projectId: Type.Optional(Id) }),
    result: object({ items: Type.Array(ChannelSchema) }),
  },
  "channel.read": {
    params: object({ id: Id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
    result: ChannelReadSchema,
  },
  /** The owner posts. `id` is chosen by the client, so a retry never posts twice. */
  "channel.post": {
    params: object({
      channelId: Id,
      id: Id,
      text: PostText,
      mentions: Type.Optional(Type.Array(Id, { maxItems: 32 })),
    }),
    result: object({ post: ChannelPostSchema, request: ChannelRequestSchema }),
  },
  /** Stop cancels the request's running tasks, so it needs the owner's confirmation. */
  "channel.request": {
    params: object({
      id: Id,
      action: ChannelRequestActionSchema,
      revision: Type.Integer({ minimum: 1 }),
      leadThreadId: Type.Optional(Id),
      confirmed: Type.Optional(Type.Boolean()),
    }),
    result: ChannelRequestSchema,
  },
};
