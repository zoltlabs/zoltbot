import {
  CHANNEL_REQUEST_STATES,
  type ChannelDetail,
  type ChannelPostView,
  type ChannelRequestState,
  type ChannelRequestView,
  type ChannelSpeaker,
  type ChannelSummary,
} from "../shared/channels";
import type { Row, Snapshot } from "./daemon-client";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** What `channel.read` returns: daemon rows, before names are filled in. */
export interface ChannelReadResult {
  channel: Row;
  posts: Row[];
  requests: Row[];
  tasks: Row[];
  waiting: Row[];
  more: boolean;
}

/** A member's display name: the employee's name for a task chat, else the chat's title. */
export function memberName(snapshot: Snapshot, threadId: string): string {
  const thread = (snapshot.entities.thread ?? []).find((row) => row.id === threadId);
  if (!thread) return "Someone";
  const profile = (snapshot.entities.agent ?? []).find((row) => row.id === thread.agentId);
  if (thread.kind === "task" && text(profile?.name)) return text(profile?.name);
  return text(thread.title) || "Someone";
}

function summary(row: Row, requests: Row[]): ChannelSummary {
  return {
    id: text(row.id),
    projectId: text(row.projectId),
    kind: row.kind === "project" ? "project" : "team",
    name: text(row.name),
    leadThreadId: text(row.leadThreadId),
    memberCount: list(row.memberThreadIds).length,
    activeRequests: requests.filter(
      (request) =>
        request.channelId === row.id && (request.state === "open" || request.state === "running"),
    ).length,
  };
}

/** Live channels in projects that are not archived. The project channel comes first. */
export function toChannelSummaries(snapshot: Snapshot): ChannelSummary[] {
  const archived = new Set(
    (snapshot.entities.project ?? []).filter((row) => row.archived === true).map((row) => row.id),
  );
  const requests = snapshot.entities.channelRequest ?? [];
  return (snapshot.entities.channel ?? [])
    .filter((row) => !row.archivedAt && !archived.has(row.projectId))
    .map((row) => summary(row, requests))
    .sort(
      (a, b) =>
        a.projectId.localeCompare(b.projectId) ||
        Number(a.kind === "team") - Number(b.kind === "team") ||
        a.name.localeCompare(b.name),
    );
}

function speaker(snapshot: Snapshot, author: unknown): ChannelSpeaker {
  const value = author as Row | undefined;
  if (value?.kind === "thread")
    return {
      kind: "member",
      threadId: text(value.threadId),
      name: memberName(snapshot, text(value.threadId)),
    };
  return { kind: "owner" };
}

/** The channel page's model: names filled in from the snapshot. */
export function toChannelDetail(snapshot: Snapshot, read: ChannelReadResult): ChannelDetail {
  const channel = summary(read.channel, read.requests);
  const posts: ChannelPostView[] = read.posts.map((post) => ({
    id: text(post.id),
    author: speaker(snapshot, post.author),
    text: text(post.text),
    to: list(post.recipients).map((id) => memberName(snapshot, id)),
    requestId: text(post.requestId) || null,
    question: post.question === true,
    createdAt: text(post.createdAt),
  }));
  const requests: ChannelRequestView[] = read.requests.map((request) => ({
    id: text(request.id),
    title: text(request.title) || "Request",
    state: CHANNEL_REQUEST_STATES.includes(request.state as ChannelRequestState)
      ? (request.state as ChannelRequestState)
      : "open",
    revision: Number(request.revision) || 1,
    leadThreadId: text(request.leadThreadId),
    leadName: memberName(snapshot, text(request.leadThreadId)),
    tasks: read.tasks
      .filter((task) => task.requestId === request.id)
      .map((task) => ({
        id: text(task.id),
        title: text(task.title) || "Task",
        state: text(task.state),
        threadId: text(task.threadId) || null,
      })),
    createdAt: text(request.createdAt),
  }));
  return {
    channel,
    members: list(read.channel.memberThreadIds).map((threadId) => ({
      threadId,
      name: memberName(snapshot, threadId),
      lead: threadId === channel.leadThreadId,
    })),
    posts,
    requests,
    waiting: read.waiting.map((row) => {
      const asked = speaker(snapshot, row.askedBy);
      return {
        postId: text(row.postId),
        threadId: text(row.threadId),
        name: memberName(snapshot, text(row.threadId)),
        askedBy: asked.kind === "owner" ? "You" : asked.name,
        since: text(row.since),
      };
    }),
    more: read.more === true,
  };
}
