/** Team channel types the sidebar and the channel page share across the IPC boundary. */

export const CHANNEL_REQUEST_STATES = ["open", "running", "done", "stopped", "archived"] as const;
export type ChannelRequestState = (typeof CHANNEL_REQUEST_STATES)[number];

export const CHANNEL_REQUEST_ACTIONS = [
  "stop",
  "resume",
  "reassign",
  "archive",
  "restore",
] as const;
export type ChannelRequestActionName = (typeof CHANNEL_REQUEST_ACTIONS)[number];

/** One channel as the sidebar lists it. */
export interface ChannelSummary {
  id: string;
  projectId: string;
  kind: "team" | "project";
  name: string;
  leadThreadId: string;
  memberCount: number;
  /** Requests still open or running. */
  activeRequests: number;
}

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
  question: boolean;
  createdAt: string;
}

export interface ChannelTaskView {
  id: string;
  title: string;
  state: string;
  threadId: string | null;
}

export interface ChannelRequestView {
  id: string;
  title: string;
  state: ChannelRequestState;
  revision: number;
  leadThreadId: string;
  leadName: string;
  tasks: ChannelTaskView[];
  createdAt: string;
}

export interface ChannelWaitingView {
  postId: string;
  threadId: string;
  name: string;
  askedBy: string;
  since: string;
}

export interface ChannelDetail {
  channel: ChannelSummary;
  members: ChannelMember[];
  posts: ChannelPostView[];
  requests: ChannelRequestView[];
  waiting: ChannelWaitingView[];
  more: boolean;
}

export interface PostChannelInput {
  channelId: string;
  /** Chosen by the renderer so a retry posts once. */
  postId: string;
  text: string;
  /** Members picked from the mention list, by chat id. */
  mentions?: string[];
}

export interface ReadEarlierPostsInput {
  channelId: string;
  /** The oldest post shown; the page ends just before it. */
  before: string;
}

export interface ChannelRequestInput {
  requestId: string;
  action: ChannelRequestActionName;
  revision: number;
  /** The new lead, for reassign. */
  leadThreadId?: string;
}
