import type { Channel, ChannelPost, ChannelRequest, DomainEvent } from "@zoltbot/protocol";
import {
  channelEvent,
  liveChannel,
  memberName,
  renumberEvents,
  resolveMentions,
} from "./channels.js";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { queueHumanInput } from "./input-queue.js";
import { applyEvents, type DomainState } from "./projectors.js";
import {
  activeSender,
  messageTeam,
  type TeamActor,
  teamHopLimit,
  teamMessageRate,
  turnHops,
  turnRequestId,
} from "./team.js";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const owner = { kind: "human" as const, id: "local-owner" };

/** Posts one chat may make in one channel per minute, on top of the per-recipient limit. */
export const channelPostRate = teamMessageRate;
/** Requests that are still being worked on, which an agent's post can belong to. */
const activeRequestStates = ["open", "running"];

function checkText(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || value.length > max) throw new Error("invalid_post");
  return value;
}
/** A request title: the first line of the post, cut at a word. */
export function requestTitle(body: string): string {
  const first = body.trim().split("\n")[0]?.trim() ?? "";
  if (first.length <= 80) return first || "Request";
  const cut = first.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80).trimEnd()}…`;
}

/**
 * The owner's words to one member chat, delivered like a teammate's message: a message record
 * tagged with the channel, then a queued input that names it. The daemon wakes the chat.
 */
export function ownerChannelMessage(
  state: DomainState,
  input: {
    channel: Channel;
    threadId: string;
    messageId: string;
    requestId?: string;
    header: string;
    text: string;
    root?: string;
  },
  context: CommandContext,
): DomainEvent[] {
  const thread = state.thread?.find((row) => row.id === input.threadId && !row.archived);
  if (!thread) throw new Error("chat_unavailable");
  const framed = `${input.header}\n${input.text}`;
  const message = handle(
    state,
    {
      type: "create",
      kind: "message",
      value: {
        id: input.messageId,
        thread: input.threadId,
        channelId: input.channel.id,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        from: owner,
        to: [{ kind: "agent", id: text(thread.agentId) }],
        kind: "message",
        expectsReply: true,
        priority: "normal",
        delivery: "next_turn",
        root: input.root ?? input.messageId,
        hops: 0,
        ttlHops: teamHopLimit,
        origin: "human",
        body: [{ type: "text", text: framed }],
        createdAt: context.at,
      },
    },
    { ...context, commandId: `${context.commandId}:${input.messageId}` },
  );
  const queued = queueHumanInput(
    applyEvents(state, message.events),
    {
      threadId: input.threadId,
      input: [{ type: "text", text: framed }],
      mode: "queue",
      notice: {
        kind: "team",
        type: "question",
        messageId: input.messageId,
        channelId: input.channel.id,
        preview: input.text.slice(0, 300),
      },
    },
    `${input.messageId}:input`,
    { ...context, commandId: `${context.commandId}:${input.messageId}:queue` },
  );
  return [
    ...message.events,
    ...queued.events.map((event) =>
      event.aggregateType === "item"
        ? {
            ...event,
            payload: {
              ...(event.payload as Record<string, unknown>),
              body: {
                ...(event.payload as { body: object }).body,
                sourceMessageId: input.messageId,
              },
            },
          }
        : event,
    ),
  ];
}

/**
 * The owner posts in a channel. It goes to the members it @mentions, or to the lead, and
 * starts a request the lead owns.
 */
export function postOwnerToChannel(
  state: DomainState,
  input: { channelId: string; postId: string; text: string; mentions?: string[] },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_post_required");
  const channel = liveChannel(state, input.channelId);
  const body = checkText(input.text, 4000);
  if (state.channelPost?.some((row) => row.id === input.postId))
    throw new Error("already_exists: channelPost");
  const mentions = resolveMentions(state, channel, body, input.mentions);
  const recipients = mentions.length ? mentions : [channel.leadThreadId];
  const requestId = `request-${input.postId}`;
  const lead = memberName(state, channel.leadThreadId);
  let events: DomainEvent[] = [];
  const messageIds: string[] = [];
  recipients.forEach((threadId, index) => {
    const messageId = `${input.postId}:to:${index}`;
    const leads = threadId === channel.leadThreadId;
    const header = leads
      ? `[#${channel.name} · request from the owner, message ${messageId}. You lead it: assign work with team_delegate (those tasks join the request), and post progress and answers with team_message channelId ${channel.id} replyTo ${messageId}. @Name in your text reaches a member.]`
      : `[#${channel.name} · the owner mentioned you, message ${messageId}. ${lead} leads this request. Answer in the channel with team_message channelId ${channel.id} replyTo ${messageId}.]`;
    events = [
      ...events,
      ...ownerChannelMessage(
        applyEvents(state, events),
        { channel, threadId, messageId, requestId, header, text: body, root: input.postId },
        context,
      ),
    ];
    messageIds.push(messageId);
  });
  const post: ChannelPost = {
    id: input.postId,
    channelId: channel.id,
    projectId: channel.projectId,
    author: { kind: "owner" },
    text: body,
    mentions,
    recipients,
    messageIds,
    requestId,
    question: true,
    createdAt: context.at,
  };
  const request: ChannelRequest = {
    id: requestId,
    channelId: channel.id,
    projectId: channel.projectId,
    postId: input.postId,
    title: requestTitle(body),
    leadThreadId: channel.leadThreadId,
    state: "open",
    revision: 1,
    createdAt: context.at,
    updatedAt: context.at,
  };
  events.push(
    channelEvent("channelPost", post, context, "created", 0),
    channelEvent("channelRequest", request, context, "created", 0),
    channelEvent(
      "audit",
      {
        id: `${input.postId}:audit`,
        actor: context.actor,
        action: "channel.post",
        target: channel.id,
        result: "allowed",
        detail: { postId: input.postId, requestId, recipients },
        at: context.at,
      },
      context,
      "created",
      0,
    ),
  );
  return {
    events: renumberEvents(events, context),
    result: { post, request, wake: recipients },
  };
}

export interface ChannelMessageInput {
  channelId: string;
  text: string;
  /** True when the recipients owe a reply. */
  question?: boolean;
  /** A message this chat received in the channel. The reply goes back to its author. */
  replyTo?: string;
  /** Chat ids or member names, on top of the @Names in the text. */
  mentions?: string[];
}
/**
 * A member posts in its channel. It reaches the members it @mentions, or the lead when it
 * mentions no one; a reply also reaches the author it answers. Each delivery is an ordinary
 * team message, so hop limits, rate limits and the audit log apply as for any other message.
 */
export function postAgentToChannel(
  state: DomainState,
  actor: TeamActor,
  input: ChannelMessageInput,
  postId: string,
  context: CommandContext,
): Outcome {
  const sender = activeSender(state, actor, context);
  const channel = liveChannel(state, input.channelId);
  if (!channel.memberThreadIds.includes(sender.id)) throw new Error("not_channel_member");
  const body = checkText(input.text, 2000);
  if (state.channelPost?.some((row) => row.id === postId))
    throw new Error("already_exists: channelPost");
  const hops = turnHops(state, sender.id, actor.turnId) + 1;
  if (hops > teamHopLimit) throw new Error("hop_limit_reached");
  const since = new Date(Date.parse(context.at) - 60000).toISOString();
  const recent = (state.channelPost ?? []).filter(
    (row) =>
      row.channelId === channel.id &&
      (row.author as { threadId?: string }).threadId === sender.id &&
      text(row.createdAt) > since,
  ).length;
  if (recent >= channelPostRate) throw new Error("rate_limited");
  let answering: { post: ChannelPost; message: Record<string, unknown> } | undefined;
  if (input.replyTo) {
    const message = state.message?.find(
      (row) => row.id === input.replyTo && row.thread === sender.id,
    );
    const post = (state.channelPost ?? []).find((row) =>
      (row.messageIds as string[]).includes(text(input.replyTo)),
    ) as ChannelPost | undefined;
    if (!message || message.channelId !== channel.id || !post) throw new Error("reply_not_found");
    answering = { post, message };
  }
  const mentions = resolveMentions(state, channel, body, input.mentions).filter(
    (id) => id !== sender.id,
  );
  const author =
    answering?.post.author.kind === "thread" && answering.post.author.threadId !== sender.id
      ? answering.post.author.threadId
      : undefined;
  const recipients = answering
    ? [...new Set([...(author ? [author] : []), ...mentions])]
    : mentions.length
      ? mentions
      : channel.leadThreadId === sender.id
        ? []
        : [channel.leadThreadId];
  const turnRequest = turnRequestId(state, sender.id, actor.turnId);
  const open = (state.channelRequest ?? []).filter(
    (row) => row.channelId === channel.id && activeRequestStates.includes(text(row.state)),
  );
  const requestId =
    text(answering?.message.requestId) ||
    open.find((row) => row.id === turnRequest)?.id ||
    (open.length === 1 ? open[0]?.id : undefined);
  let events: DomainEvent[] = [];
  const messageIds: string[] = [];
  const wake: string[] = [];
  recipients.forEach((threadId, index) => {
    const messageId = `${postId}:to:${index}`;
    const replyTo =
      answering && threadId === author && answering.message.fromThread === threadId
        ? input.replyTo
        : undefined;
    const out = messageTeam(
      applyEvents(state, events),
      actor,
      {
        text: body,
        to: threadId,
        kind: input.question ? "question" : "update",
        ...(replyTo ? { replyTo } : {}),
        channel: {
          id: channel.id,
          name: channel.name,
          ...(requestId ? { requestId: String(requestId) } : {}),
        },
      },
      messageId,
      { ...context, commandId: `${context.commandId}:${messageId}` },
    );
    events = [...events, ...out.events];
    messageIds.push(messageId);
    if (out.result.wake) wake.push(threadId);
  });
  const post: ChannelPost = {
    id: postId,
    channelId: channel.id,
    projectId: channel.projectId,
    author: { kind: "thread", threadId: sender.id },
    text: body,
    mentions,
    recipients,
    messageIds,
    ...(requestId ? { requestId: String(requestId) } : {}),
    ...(answering ? { replyTo: answering.post.id } : {}),
    question: input.question === true && recipients.length > 0,
    createdAt: context.at,
  };
  events.push(channelEvent("channelPost", post, context, "created", 0));
  return {
    events: renumberEvents(events, context),
    result: { post, wake, text: body },
  };
}
