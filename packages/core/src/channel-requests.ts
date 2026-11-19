import {
  type ChannelRequest,
  type ChannelRequestAction,
  ChannelRequestSchema,
  ChannelSchema,
  type DomainEvent,
  parse,
} from "@zoltbot/protocol";
import { ownerChannelMessage } from "./channel-posts.js";
import { channelEvent, memberName, renumberEvents } from "./channels.js";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const finalTaskStates = ["completed", "cancelled", "failed"];

/** Tasks the request's lead assigned while handling it that have not finished. */
export function openRequestTasks(state: DomainState, requestId: string) {
  return (state.task ?? []).filter(
    (task) => task.requestId === requestId && !finalTaskStates.includes(text(task.state)),
  );
}

const allowed: Record<ChannelRequestAction, ChannelRequest["state"][]> = {
  stop: ["open", "running"],
  resume: ["stopped"],
  reassign: ["open", "running", "stopped"],
  archive: ["open", "running", "done", "stopped"],
  restore: ["archived"],
};
/**
 * The owner acts on a request: Stop (its open tasks are cancelled by the caller, which holds
 * the confirmation), Resume, Reassign to another member as lead, Archive and Restore. The lead
 * hears about Stop, Resume and a reassignment through the channel's ordinary messages.
 */
export function channelRequestAction(
  state: DomainState,
  input: {
    id: string;
    action: ChannelRequestAction;
    revision: number;
    leadThreadId?: string;
    confirmed?: boolean;
  },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_action_required");
  const row = state.channelRequest?.find((entry) => entry.id === input.id);
  if (!row) throw new Error("not_found: channelRequest");
  const request = parse(ChannelRequestSchema, row);
  if (request.revision !== input.revision) throw new Error("stale_revision: request changed");
  if (!allowed[input.action].includes(request.state))
    throw new Error(`invalid_request_action: ${input.action} from ${request.state}`);
  const cancel = input.action === "stop" ? openRequestTasks(state, request.id) : [];
  if (cancel.length && input.confirmed !== true)
    throw new Error("confirmation_required: stopping cancels the request's tasks");
  const channel = state.channel?.find((entry) => entry.id === request.channelId);
  if (!channel) throw new Error("not_found: channel");
  const members = channel.memberThreadIds as string[];
  let next: ChannelRequest = { ...request, revision: request.revision + 1, updatedAt: context.at };
  let notify: { threadId: string; header: string } | undefined;
  const name = text(channel.name);
  const post = state.channelPost?.find((entry) => entry.id === request.postId);
  const quoted = `"${request.title}"`;
  switch (input.action) {
    case "stop":
      next = { ...next, state: "stopped" };
      notify = {
        threadId: request.leadThreadId,
        header: `[#${name} · the owner stopped request ${quoted}. Its tasks are cancelled. Don't continue it unless the owner resumes it.]`,
      };
      break;
    case "resume":
      next = { ...next, state: "open" };
      notify = {
        threadId: request.leadThreadId,
        header: `[#${name} · the owner resumed request ${quoted}. Pick it back up and post progress with team_message channelId ${text(channel.id)}.]`,
      };
      break;
    case "reassign": {
      const lead = input.leadThreadId;
      if (!lead || !members.includes(lead) || lead === request.leadThreadId)
        throw new Error("lead_not_member");
      next = { ...next, leadThreadId: lead };
      notify = {
        threadId: lead,
        header: `[#${name} · the owner made you lead of request ${quoted}, which ${memberName(state, request.leadThreadId)} led until now. Assign work with team_delegate (those tasks join the request) and post progress with team_message channelId ${text(channel.id)}.]`,
      };
      break;
    }
    case "archive":
      next = { ...next, state: "archived", archivedFrom: request.state as "open" };
      break;
    case "restore": {
      const { archivedFrom, ...rest } = next;
      next = { ...rest, state: archivedFrom ?? "open" };
      break;
    }
  }
  const events: DomainEvent[] = [
    channelEvent("channelRequest", next, context, "updated", 0),
    channelEvent(
      "audit",
      {
        id: `${context.commandId}:audit`,
        actor: context.actor,
        action: `channel.request.${input.action}`,
        target: request.id,
        result: "allowed",
        detail: {
          channelId: request.channelId,
          ...(cancel.length ? { cancelled: cancel.map((task) => text(task.id)) } : {}),
          ...(input.leadThreadId ? { leadThreadId: input.leadThreadId } : {}),
          confirmed: input.confirmed === true,
        },
        at: context.at,
      },
      context,
      "created",
      0,
    ),
  ];
  const wake: string[] = [];
  if (notify && state.thread?.some((entry) => entry.id === notify.threadId && !entry.archived)) {
    const messageId = `${context.commandId}:notice`;
    events.push(
      ...ownerChannelMessage(
        state,
        {
          channel: parse(ChannelSchema, channel),
          threadId: notify.threadId,
          messageId,
          requestId: request.id,
          header: notify.header,
          text: text(post?.text) || request.title,
        },
        context,
      ),
    );
    wake.push(notify.threadId);
  }
  return {
    events: renumberEvents(events, context),
    result: { request: next, cancel: cancel.map((task) => text(task.id)), wake },
  };
}

/**
 * Moves requests between open, running and done as their tasks change: running while any
 * task is open, done once every task finished, or once the lead answered and stopped working
 * on a request that needed no tasks. Stopped and archived requests stay as the owner left them.
 */
export function settleChannelRequests(state: DomainState, context: CommandContext): Outcome {
  const events: DomainEvent[] = [];
  for (const row of state.channelRequest ?? []) {
    const state0 = text(row.state);
    if (!["open", "running", "done"].includes(state0)) continue;
    const tasks = (state.task ?? []).filter((task) => task.requestId === row.id);
    let derived: string;
    if (tasks.some((task) => !finalTaskStates.includes(text(task.state)))) derived = "running";
    else if (tasks.length) derived = "done";
    else {
      const lead = text(row.leadThreadId);
      const answered = (state.channelPost ?? []).some(
        (post) =>
          post.channelId === row.channelId &&
          (post.author as { threadId?: string }).threadId === lead &&
          (post.replyTo === row.postId || post.requestId === row.id),
      );
      const busy =
        state.turn?.some((turn) => turn.threadId === lead && turn.status === "running") ||
        state.item?.some(
          (item) =>
            item.threadId === lead &&
            item.kind === "user" &&
            (item.body as { queueState?: string })?.queueState === "queued",
        );
      derived = answered && !busy ? "done" : state0 === "done" ? "done" : "open";
    }
    if (derived === state0) continue;
    events.push(
      channelEvent(
        "channelRequest",
        { ...row, state: derived, revision: Number(row.revision) + 1, updatedAt: context.at },
        context,
        "updated",
        0,
      ),
    );
  }
  return {
    events: renumberEvents(events, context),
    result: { changed: events.map((event) => event.aggregateId) },
  };
}
