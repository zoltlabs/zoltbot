import type {
  ChannelAuthor,
  ChannelRead,
  ChannelRequestAction,
  ChannelRequestState,
} from "@zoltbot/protocol";
import type { Snapshot } from "./transport.js";
import { ago } from "./view.js";

// Pure selectors for a team channel: what the channel screen and its sheet show. No React here.

/** Rows whose changes can change what a channel shows; the screen re-reads when one changes. */
export const channelKinds = new Set(["channel", "channelPost", "channelRequest", "task"]);

export interface ChannelMember {
  threadId: string;
  name: string;
  lead: boolean;
}
export type ChannelSpeaker = { kind: "owner" } | { kind: "member"; threadId: string; name: string };

export interface ChannelPostView {
  id: string;
  author: ChannelSpeaker;
  text: string;
  /** Names the post reached. */
  to: string[];
  requestId: string | null;
  createdAt: string;
  /** Shown before the Mac has stored it. */
  sending?: boolean;
}
export interface ChannelTaskView {
  id: string;
  title: string;
  state: string;
  threadId: string | null;
  /** The employee doing the task, when known. */
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ChannelRequestView {
  id: string;
  title: string;
  state: ChannelRequestState;
  revision: number;
  leadThreadId: string;
  leadName: string;
  tasks: ChannelTaskView[];
  updatedAt: string;
}
export interface ChannelWaitingView {
  postId: string;
  threadId: string;
  name: string;
  /** The question still waiting for an answer. */
  question: string;
  since: string;
}
export interface ChannelView {
  id: string;
  name: string;
  leadThreadId: string;
  /** Lead first, then by name. */
  members: ChannelMember[];
  posts: ChannelPostView[];
  requests: ChannelRequestView[];
  waiting: ChannelWaitingView[];
  more: boolean;
  archived: boolean;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A member's name: the employee's name for a task chat, else the chat's title. */
export function memberName(snapshot: Snapshot, threadId: string): string {
  const thread = snapshot.entities.thread?.find((row) => row.id === threadId);
  if (!thread) return "Someone";
  const profile = snapshot.entities.agent?.find((row) => row.id === thread.agentId);
  if (thread.kind === "task" && text(profile?.name)) return text(profile?.name);
  return text(thread.title) || text(profile?.name) || "Someone";
}

function speaker(snapshot: Snapshot, author: ChannelAuthor): ChannelSpeaker {
  if (author.kind === "thread")
    return {
      kind: "member",
      threadId: author.threadId,
      name: memberName(snapshot, author.threadId),
    };
  return { kind: "owner" };
}

export function toPostView(
  snapshot: Snapshot,
  post: ChannelRead["posts"][number],
): ChannelPostView {
  return {
    id: post.id,
    author: speaker(snapshot, post.author),
    text: post.text,
    to: post.recipients.map((id) => memberName(snapshot, id)),
    requestId: post.requestId ?? null,
    createdAt: post.createdAt,
  };
}

/** The channel's model, with names filled in from the snapshot. */
export function toChannelView(snapshot: Snapshot, read: ChannelRead): ChannelView {
  const { channel } = read;
  const posts = read.posts.map((post) => toPostView(snapshot, post));
  const members = channel.memberThreadIds
    .map((threadId) => ({
      threadId,
      name: memberName(snapshot, threadId),
      lead: threadId === channel.leadThreadId,
    }))
    .sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name));
  const byId = new Map(read.posts.map((post) => [post.id, post]));
  return {
    id: channel.id,
    name: channel.name,
    leadThreadId: channel.leadThreadId,
    members,
    posts,
    requests: read.requests.map((request) => ({
      id: request.id,
      title: request.title,
      state: request.state,
      revision: request.revision,
      leadThreadId: request.leadThreadId,
      leadName: memberName(snapshot, request.leadThreadId),
      tasks: read.tasks
        .filter((task) => task.requestId === request.id)
        .map((task) => ({
          id: task.id,
          title: task.title || "Task",
          state: task.state,
          threadId: task.threadId ?? null,
          assignee: task.threadId ? memberName(snapshot, task.threadId) : null,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        })),
      updatedAt: request.updatedAt,
    })),
    waiting: read.waiting.map((row) => ({
      postId: row.postId,
      threadId: row.threadId,
      name: memberName(snapshot, row.threadId),
      question: byId.get(row.postId)?.text ?? "",
      since: row.since,
    })),
    more: read.more,
    archived: Boolean(channel.archivedAt),
  };
}

/**
 * The open channel as shown: older pages loaded with Show earlier above the newest page, and
 * posts still sending below it. A post in more than one list shows once.
 */
export function mergePosts(
  earlier: readonly ChannelPostView[],
  newest: readonly ChannelPostView[],
  sending: readonly ChannelPostView[],
): ChannelPostView[] {
  const seen = new Set(newest.map((post) => post.id));
  const older = earlier.filter((post) => !seen.has(post.id));
  for (const post of older) seen.add(post.id);
  return [...older, ...newest, ...sending.filter((post) => !seen.has(post.id))];
}

// Mentions and routing ---------------------------------------------------------------------

/** The @mention being typed just before the caret, if any. */
export function mentionAt(
  value: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  const match = value.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,40})$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  return { query, start: caret - query.length - 1, end: caret };
}

/** Members whose name starts with the query, lead first. */
export function matchMembers(members: readonly ChannelMember[], query: string): ChannelMember[] {
  const q = query.toLocaleLowerCase();
  return members
    .filter((member) => member.name.toLocaleLowerCase().startsWith(q))
    .sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name));
}

/** Replaces the typed mention with the member's name; returns the new text and caret. */
export function insertMention(
  value: string,
  mention: { start: number; end: number },
  member: ChannelMember,
): { value: string; caret: number } {
  const inserted = `@${member.name} `;
  return {
    value: value.slice(0, mention.start) + inserted + value.slice(mention.end),
    caret: mention.start + inserted.length,
  };
}

/** Chats the text @mentions by name, longest names first so "@Sam Lee" beats "@Sam". */
export function mentionedMembers(value: string, members: readonly ChannelMember[]): string[] {
  const found: string[] = [];
  let rest = value;
  for (const member of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const escaped = member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_])`, "giu");
    if (pattern.test(rest)) {
      found.push(member.threadId);
      rest = rest.replace(pattern, "$1");
    }
  }
  return found;
}

/** Who a new post reaches: the members it @mentions, else the lead. */
export function recipientsFor(value: string, members: readonly ChannelMember[]): ChannelMember[] {
  const named = mentionedMembers(value, members);
  if (named.length) return members.filter((member) => named.includes(member.threadId));
  return members.filter((member) => member.lead);
}

/** "Mira", "Sam and Theo", "Sam, Theo and Mira". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "To Mira": who the post reached or will reach. Empty when nobody would. */
export function recipientLabel(names: readonly string[]): string {
  return names.length ? `To ${nameList(names)}` : "";
}

/** A post shown at once, before the Mac has stored it. */
export function sendingPost(
  id: string,
  value: string,
  members: readonly ChannelMember[],
  at: string,
): ChannelPostView {
  return {
    id,
    author: { kind: "owner" },
    text: value,
    to: recipientsFor(value, members).map((member) => member.name),
    requestId: null,
    createdAt: at,
    sending: true,
  };
}

// Transcript -------------------------------------------------------------------------------

const TASK_DONE: Record<string, string> = {
  completed: "is done",
  failed: "failed",
  cancelled: "was stopped",
};

export type TranscriptEntry =
  | { kind: "post"; key: string; post: ChannelPostView }
  | { kind: "notice"; key: string; text: string };

/**
 * Posts and task events in time order. Each task the lead assigned shows as one line, and a
 * second line when it finished.
 */
export function channelTranscript(
  view: Pick<ChannelView, "posts" | "requests">,
): TranscriptEntry[] {
  const first = view.posts[0]?.createdAt ?? "";
  const notices: (TranscriptEntry & { at: string })[] = [];
  for (const request of view.requests)
    for (const task of request.tasks) {
      const to = task.assignee ? ` to ${task.assignee}` : "";
      notices.push({
        kind: "notice",
        key: `${task.id}:assigned`,
        text: `${request.leadName} assigned ${task.title}${to}`,
        at: task.createdAt,
      });
      const done = TASK_DONE[task.state];
      if (done)
        notices.push({
          kind: "notice",
          key: `${task.id}:${task.state}`,
          text: `${task.title} ${done}`,
          at: task.updatedAt,
        });
    }
  const entries: (TranscriptEntry & { at: string })[] = [
    ...view.posts.map((post) => ({
      kind: "post" as const,
      key: post.id,
      post,
      // Posts still sending stay last, whatever the phone's clock says.
      at: post.sending ? "￿" : post.createdAt,
    })),
    // Older task events wait until Show earlier reaches their posts.
    ...notices.filter((notice) => notice.at >= first),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.index - b.index)
    .map(({ entry: { at: _at, ...rest } }) => rest as TranscriptEntry);
}

// Requests ---------------------------------------------------------------------------------

const OPEN_TASK_STATES = ["queued", "running", "blocked", "review"];

/** Tasks a Stop would cancel. */
export function openTasks(request: ChannelRequestView): ChannelTaskView[] {
  return request.tasks.filter((task) => OPEN_TASK_STATES.includes(task.state));
}

/** The request the bar shows: the newest one open or running. */
export function currentRequest(requests: readonly ChannelRequestView[]) {
  return (
    [...requests]
      .reverse()
      .find((request) => request.state === "open" || request.state === "running") ?? null
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The line under a request's title: "2 tasks running", "Stopped", "Yesterday". */
export function requestMeta(request: ChannelRequestView, now = Date.now()): string {
  if (request.state === "done" || request.state === "archived") {
    const when = ago(request.updatedAt, now);
    const label = request.state === "done" ? when : `Archived ${when}`;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (request.state === "stopped") return "Stopped";
  const running = request.tasks.filter((task) => task.state === "running").length;
  if (running) return `${plural(running, "task", "tasks")} running`;
  const open = openTasks(request).length;
  if (open) return `${plural(open, "task", "tasks")} open`;
  return `Waiting on ${request.leadName}`;
}

export interface RequestGroups {
  /** Open, running and stopped, newest first. */
  open: ChannelRequestView[];
  done: ChannelRequestView[];
  archived: ChannelRequestView[];
}

/** The sheet's sections. Each list is newest first. */
export function groupRequests(requests: readonly ChannelRequestView[]): RequestGroups {
  const newest = [...requests].reverse();
  return {
    open: newest.filter(
      (r) => r.state === "open" || r.state === "running" || r.state === "stopped",
    ),
    done: newest.filter((r) => r.state === "done"),
    archived: newest.filter((r) => r.state === "archived"),
  };
}

/** What the sheet offers for a request, in button order. */
export function requestActions(
  request: ChannelRequestView,
  memberCount: number,
): ChannelRequestAction[] {
  const reassign: ChannelRequestAction[] = memberCount > 1 ? ["reassign"] : [];
  switch (request.state) {
    case "open":
    case "running":
      return ["stop", ...reassign, "archive"];
    case "stopped":
      return ["resume", ...reassign, "archive"];
    case "done":
      return ["archive"];
    case "archived":
      return ["restore"];
  }
}

export const actionLabels: Record<ChannelRequestAction, string> = {
  stop: "Stop",
  resume: "Resume",
  reassign: "Reassign",
  archive: "Archive",
  restore: "Restore",
};

/** The confirmation Stop needs, or null when nothing would be cancelled. */
export function stopConfirmation(request: ChannelRequestView) {
  const count = openTasks(request).length;
  if (!count) return null;
  return {
    title: "Stop this request?",
    message: `This cancels ${plural(count, "task", "tasks")}. You can resume the request later.`,
  };
}

/** Members who could take over as lead. */
export function leadChoices(
  members: readonly ChannelMember[],
  request: ChannelRequestView,
): ChannelMember[] {
  return members.filter((member) => member.threadId !== request.leadThreadId);
}

/** A friendlier line for refusals the channel methods return. */
export function channelError(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (message.includes("mention_not_member")) return "Mention someone in this channel.";
  if (message.includes("stale_revision")) return "The request changed. Try again.";
  if (message.includes("invalid_request_action")) return "The request changed. Try again.";
  return message || fallback;
}

/** A client-chosen post id, kept for retries so the Mac stores the post once. */
export const newPostId = () =>
  `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
