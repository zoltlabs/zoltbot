import { createHash } from "node:crypto";
import {
  type ChannelMessageInput,
  type DomainState,
  memberName,
  postAgentToChannel,
  readChannel,
} from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import type { ChannelPost } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";

export const channelToolDefinitions = [
  {
    name: "team_channels",
    description:
      "Team channels you belong to. No channelId: list them. channelId: recent posts, open requests and who owes a reply. Post with team_message channelId; @Name reaches a member, else the lead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channelId: { type: "string", maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
];
export const channelToolNames = new Set(channelToolDefinitions.map((tool) => tool.name));
/** Refusals the model can act on, returned as results rather than a generic tool failure. */
const refusals = [
  "channel_unavailable",
  "not_channel_member",
  "mention_not_member",
  "reply_not_found",
  "reply_target_unavailable",
  "hop_limit_reached",
  "rate_limited",
  "invalid_post",
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** True when the chat is a member of a live channel, so it gets the channel tool. */
export function inChannel(context: RuntimeContext, threadId: string | undefined): boolean {
  if (!threadId) return false;
  return (
    context.store
      .snapshot(["channel"])
      .channel?.some(
        (row) => !row.archivedAt && (row.memberThreadIds as string[]).includes(threadId),
      ) === true
  );
}

function author(state: DomainState, post: ChannelPost): string {
  return post.author.kind === "owner" ? "owner" : memberName(state, post.author.threadId);
}

export function channelTools(context: RuntimeContext) {
  function authorize(actor: ToolActor) {
    const thread = context.store.record("thread", actor.threadId);
    return !!thread && !thread.archived && !thread.fork && !!thread.projectId;
  }
  async function channels(call: ToolInvocation) {
    const args = call.arguments as { channelId?: string; limit?: number };
    const state = context.store.snapshot([
      "channel",
      "channelPost",
      "channelRequest",
      "thread",
      "agent",
      "task",
    ]);
    const mine = (state.channel ?? []).filter(
      (row) => !row.archivedAt && (row.memberThreadIds as string[]).includes(call.actor.threadId),
    );
    if (!args.channelId)
      return {
        channels: mine.map((row) => ({
          channelId: row.id,
          name: `#${text(row.name)}`,
          lead: memberName(state, text(row.leadThreadId)),
          youLead: row.leadThreadId === call.actor.threadId,
          members: (row.memberThreadIds as string[]).map((id) => memberName(state, id)),
        })),
      };
    if (!mine.some((row) => row.id === args.channelId)) return { error: "not_channel_member" };
    const view = readChannel(state, args.channelId, args.limit ?? 20);
    const result = {
      name: `#${view.channel.name}`,
      lead: memberName(state, view.channel.leadThreadId),
      posts: view.posts.map((post) => ({
        from: author(state, post),
        text: post.text.length > 600 ? `${post.text.slice(0, 600)}…` : post.text,
        ...(post.recipients.length
          ? { to: post.recipients.map((id) => memberName(state, id)) }
          : {}),
        ...(post.requestId ? { requestId: post.requestId } : {}),
        at: post.createdAt,
      })),
      requests: view.requests
        .filter((row) => ["open", "running", "stopped"].includes(row.state))
        .map((row) => ({
          requestId: row.id,
          title: row.title,
          state: row.state,
          lead: memberName(state, row.leadThreadId),
          tasks: view.tasks
            .filter((task) => task.requestId === row.id)
            .map((task) => ({ taskId: task.id, title: task.title, state: task.state })),
        })),
      waiting: view.waiting.map((row) => ({
        owes: memberName(state, row.threadId),
        askedBy: row.askedBy.kind === "owner" ? "owner" : memberName(state, row.askedBy.threadId),
        since: row.since,
      })),
      more: view.more,
    };
    while (JSON.stringify(result).length > 6000 && result.posts.length > 1) result.posts.shift();
    return result;
  }
  return {
    authorize,
    tools: new Map<string, (call: ToolInvocation) => Promise<unknown>>([
      ["team_channels", channels],
    ]),
  };
}

/** `team_message` with a channelId: post in the channel and wake the members it reaches. */
export async function postChannelMessage(
  context: RuntimeContext,
  actor: ToolActor,
  args: { key: string; channelId: string; text: string; question?: boolean; replyTo?: string },
) {
  const postId = `post-${hash(JSON.stringify([actor.threadId, args.key]))}`;
  const commandId = `channel:post:${postId}`;
  const input: ChannelMessageInput = {
    channelId: args.channelId,
    text: args.text,
    ...(args.question ? { question: true } : {}),
    ...(args.replyTo ? { replyTo: args.replyTo } : {}),
  };
  let result: { post: ChannelPost; wake: string[] };
  try {
    const check = await context.privacy.prepareData(input);
    const before = context.store.lastSeq();
    const receipt = context.store.dispatch(commandId, (state) => {
      check(state);
      return postAgentToChannel(state, actor, input, postId, {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "agent", id: actor.agentId },
      });
    });
    context.publish(context.store.eventsSince(before));
    result = receipt.result as typeof result;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const known = refusals.find((name) => code.startsWith(name));
    if (known) return { error: known };
    throw error;
  }
  if (result.post.text !== args.text) throw new Error("command_receipt_conflict");
  let woken = true;
  for (const threadId of result.wake)
    await context.wake(threadId).catch(() => {
      woken = false;
    });
  const state = context.store.snapshot(["thread", "agent"]);
  return {
    postId,
    channelId: args.channelId,
    to: result.post.recipients.map((id) => memberName(state, id)),
    delivered: woken ? "queued" : "queued_not_woken",
  };
}
