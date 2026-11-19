import { expect, it } from "vitest";
import { parseChannelRequest, parsePostChannel } from "./channel-parsers";
import { toChannelDetail, toChannelSummaries } from "./channels-view";
import type { Snapshot } from "./daemon-client";

const at = "2026-11-19T10:00:00.000Z";
const channel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "acme",
  teamId: "pay",
  kind: "team",
  name: id,
  leadThreadId: "lead",
  memberThreadIds: ["lead", "mira-task", "theo"],
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const snapshot: Snapshot = {
  seq: 1,
  counters: {},
  entities: {
    project: [
      { id: "acme", name: "Acme", archived: false },
      { id: "old", name: "Old", archived: true },
    ],
    agent: [{ id: "mira", name: "Mira" }],
    thread: [
      { id: "lead", kind: "manager", title: "Payments" },
      { id: "mira-task", kind: "task", agentId: "mira", title: "Refund endpoint" },
      { id: "theo", kind: "side", title: "Theo" },
    ],
    channel: [
      channel("payments"),
      channel("general", { kind: "project", teamId: undefined }),
      channel("closed", { archivedAt: at }),
      channel("elsewhere", { projectId: "old" }),
    ],
    channelRequest: [
      { id: "r1", channelId: "payments", state: "running" },
      { id: "r2", channelId: "payments", state: "done" },
    ],
  },
};

it("lists live channels, the project channel first, with open request counts", () => {
  expect(toChannelSummaries(snapshot)).toEqual([
    expect.objectContaining({ id: "general", kind: "project", activeRequests: 0 }),
    expect.objectContaining({ id: "payments", memberCount: 3, activeRequests: 1 }),
  ]);
});

it("names speakers, recipients, waiting members and request tasks", () => {
  const detail = toChannelDetail(snapshot, {
    channel: channel("payments"),
    posts: [
      {
        id: "p1",
        author: { kind: "owner" },
        text: "Ship refunds",
        recipients: ["lead"],
        requestId: "r1",
        question: false,
        createdAt: at,
      },
      {
        id: "p2",
        author: { kind: "thread", threadId: "lead" },
        text: "@Theo tests?",
        recipients: ["theo"],
        requestId: "r1",
        question: true,
        createdAt: at,
      },
    ],
    requests: [
      {
        id: "r1",
        channelId: "payments",
        title: "Ship refunds",
        state: "running",
        revision: 2,
        leadThreadId: "lead",
        createdAt: at,
      },
    ],
    tasks: [{ id: "t1", requestId: "r1", title: "Refund endpoint", state: "running" }],
    waiting: [{ postId: "p2", threadId: "theo", askedBy: { kind: "thread", threadId: "lead" } }],
    more: false,
  });
  expect(detail.members).toEqual([
    { threadId: "lead", name: "Payments", lead: true },
    { threadId: "mira-task", name: "Mira", lead: false },
    { threadId: "theo", name: "Theo", lead: false },
  ]);
  expect(detail.posts.map((post) => [post.author, post.to])).toEqual([
    [{ kind: "owner" }, ["Payments"]],
    [{ kind: "member", threadId: "lead", name: "Payments" }, ["Theo"]],
  ]);
  expect(detail.requests[0]).toMatchObject({
    leadName: "Payments",
    revision: 2,
    tasks: [{ id: "t1", title: "Refund endpoint", state: "running", threadId: null }],
  });
  expect(detail.waiting).toEqual([
    { postId: "p2", threadId: "theo", name: "Theo", askedBy: "Payments", since: "" },
  ]);
});

it("checks posts and request actions from the renderer", () => {
  expect(
    parsePostChannel({
      channelId: "payments",
      postId: "post-1",
      text: "  Hi @Theo ",
      mentions: ["theo", "theo"],
    }),
  ).toEqual({ channelId: "payments", postId: "post-1", text: "Hi @Theo", mentions: ["theo"] });
  expect(() => parsePostChannel({ channelId: "payments", postId: "p", text: " " })).toThrow(
    "Write a message first.",
  );
  expect(() => parseChannelRequest({ requestId: "r1", action: "reassign", revision: 1 })).toThrow(
    "leadThreadId",
  );
  expect(parseChannelRequest({ requestId: "r1", action: "stop", revision: 3 })).toEqual({
    requestId: "r1",
    action: "stop",
    revision: 3,
  });
  expect(() => parseChannelRequest({ requestId: "r1", action: "delete", revision: 1 })).toThrow(
    "action is required.",
  );
});
