import type { DomainEvent } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { postAgentToChannel, postOwnerToChannel } from "./channel-posts.js";
import { channelRequestAction, settleChannelRequests } from "./channel-requests.js";
import { channelSlug, readChannel, syncChannels } from "./channels.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { briefTeam, teamHopLimit } from "./team.js";

const at = "2026-11-19T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
const team = (id: string, name: string) => ({
  id,
  projectId: "co",
  name,
  label: "Team",
  goal: "",
  instructions: "",
  depth: 1,
  archived: false,
  createdAt: at,
});
const chat = (id: string, title: string, kind: string, node: string) => ({
  id,
  agentId: "writer",
  projectId: "co",
  node: node === "co" ? { type: "project", id: "co" } : { type: "subproject", id: node },
  kind,
  title,
  titleSource: "human",
  pinned: false,
  archived: false,
  createdAt: at,
  lastActivityAt: at,
});
function company(): DomainState {
  const threads = [
    chat("ceo", "Atlas", "manager", "co"),
    chat("payments", "Payments", "manager", "pay"),
    chat("mira", "Mira", "side", "pay"),
    chat("theo", "Theo", "side", "pay"),
    chat("sales-chat", "Sam", "side", "sales"),
  ];
  return {
    agent: [
      {
        id: "writer",
        name: "Writer",
        definitionId: "claude",
        archived: false,
        hidden: false,
        permissionProfile: "workspace_write",
      },
    ],
    project: [
      {
        id: "co",
        name: "Company",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth: 3,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      },
    ],
    subproject: [team("pay", "Payments"), team("sales", "Sales")],
    thread: threads,
    session: threads.map((row) => ({ id: `s-${row.id}`, threadId: row.id, state: "running" })),
    turn: threads.map((row) => ({
      id: `t-${row.id}`,
      sessionId: `s-${row.id}`,
      threadId: row.id,
      status: "running",
    })),
  } as DomainState;
}
const actor = (thread: string) => ({
  agentId: "writer",
  threadId: thread,
  sessionId: `s-${thread}`,
  turnId: `t-${thread}`,
});
const human = (id: string, when = at) => ({
  commandId: id,
  at: when,
  actor: { kind: "human" as const, id: "local-owner" },
});
const agent = (id: string, when = at) => ({
  commandId: id,
  at: when,
  actor: { kind: "agent" as const, id: "writer" },
});
const system = (id: string, when = at) => ({
  commandId: id,
  at: when,
  actor: { kind: "system" as const, id: "test" },
});
function synced(state = company()) {
  return applyEvents(state, syncChannels(state, system("sync")).events);
}
const pay = "channel-team-pay";
/** The lead's runtime picked up its queued input in this turn. */
function startTurn(state: DomainState, itemId: string, turnId: string): DomainState {
  const item = state.item?.find((row) => row.id === itemId);
  return applyEvents(state, [
    {
      eventId: `claim-${itemId}`,
      aggregateType: "item",
      aggregateId: itemId,
      type: "item.updated",
      occurredAt: at,
      payload: { ...item, turnId },
    } as DomainEvent,
  ]);
}
function setTask(state: DomainState, id: string, changes: Record<string, unknown>) {
  const task = state.task?.find((row) => row.id === id);
  return applyEvents(state, [
    {
      eventId: `set-${id}-${JSON.stringify(changes)}`,
      aggregateType: "task",
      aggregateId: id,
      type: "task.updated",
      occurredAt: at,
      payload: { ...task, ...changes },
    } as DomainEvent,
  ]);
}

describe("channel records", () => {
  it("creates a channel per managed team and one for the project, and keeps members in sync", () => {
    let state = synced();
    const channels = state.channel ?? [];
    expect(channels.map((row) => [row.id, row.name, row.leadThreadId])).toEqual([
      ["channel-project-co", "general", "ceo"],
      [pay, "payments", "payments"],
    ]);
    expect(channels.find((row) => row.id === pay)?.memberThreadIds).toEqual([
      "payments",
      "mira",
      "theo",
    ]);
    expect(channels[0]?.memberThreadIds).toEqual(["ceo", "payments"]);
    // A second pass with nothing changed writes nothing.
    expect(syncChannels(state, system("again")).events).toEqual([]);
    // Archiving a member removes it; archiving the manager archives the channel.
    const theo = state.thread?.find((row) => row.id === "theo");
    state = applyEvents(state, [
      {
        eventId: "archive-theo",
        aggregateType: "thread",
        aggregateId: "theo",
        type: "thread.updated",
        occurredAt: at,
        payload: { ...theo, archived: true },
      } as DomainEvent,
    ]);
    state = applyEvents(state, syncChannels(state, system("after-theo", later(5))).events);
    expect(state.channel?.find((row) => row.id === pay)?.memberThreadIds).toEqual([
      "payments",
      "mira",
    ]);
    const manager = state.thread?.find((row) => row.id === "payments");
    state = applyEvents(state, [
      {
        eventId: "archive-manager",
        aggregateType: "thread",
        aggregateId: "payments",
        type: "thread.updated",
        occurredAt: at,
        payload: { ...manager, archived: true },
      } as DomainEvent,
    ]);
    state = applyEvents(state, syncChannels(state, system("after-manager", later(9))).events);
    expect(state.channel?.find((row) => row.id === pay)?.archivedAt).toBe(later(9));
  });

  it("names channels by slug and keeps them unique", () => {
    expect(channelSlug("Payments & Billing")).toBe("payments-billing");
    expect(channelSlug("Café")).toBe("cafe");
    expect(channelSlug("!!!")).toBe("team");
  });
});

describe("routing", () => {
  it("sends an owner post to the lead, or only to the members it mentions", () => {
    let state = synced();
    const out = postOwnerToChannel(
      state,
      { channelId: pay, postId: "p1", text: "Ship refunds by Friday. Partial refunds too." },
      human("post-1"),
    );
    state = applyEvents(state, out.events);
    expect(out.result.wake).toEqual(["payments"]);
    const message = state.message?.find((row) => row.id === "p1:to:0");
    expect(message).toMatchObject({
      thread: "payments",
      channelId: pay,
      requestId: "request-p1",
      origin: "human",
      hops: 0,
    });
    const queued = state.item?.find((row) => row.id === "p1:to:0:input");
    expect(queued?.body).toMatchObject({
      sourceMessageId: "p1:to:0",
      queueState: "queued",
      notice: { kind: "team", channelId: pay },
    });
    expect(state.channelRequest?.[0]).toMatchObject({
      id: "request-p1",
      leadThreadId: "payments",
      state: "open",
      title: "Ship refunds by Friday. Partial refunds too.",
    });
    const mentioned = postOwnerToChannel(
      state,
      { channelId: pay, postId: "p2", text: "@Theo can you check the webhook logs?" },
      human("post-2"),
    );
    expect(mentioned.result.wake).toEqual(["theo"]);
    const explicit = postOwnerToChannel(
      state,
      { channelId: pay, postId: "p3", text: "Both of you, please", mentions: ["mira", "theo"] },
      human("post-3"),
    );
    expect(explicit.result.wake).toEqual(["mira", "theo"]);
    expect(() =>
      postOwnerToChannel(
        state,
        { channelId: pay, postId: "p4", text: "Hi", mentions: ["sales-chat"] },
        human("post-4"),
      ),
    ).toThrow("mention_not_member");
  });

  it("sends an agent post to its mentions or the lead, and a reply back to the asker", () => {
    let state = synced();
    const update = postAgentToChannel(
      state,
      actor("mira"),
      { channelId: pay, text: "Endpoint is at POST /refunds." },
      "a1",
      agent("a1"),
    );
    state = applyEvents(state, update.events);
    expect(update.result.post).toMatchObject({ recipients: ["payments"], question: false });
    expect(state.message?.find((row) => row.id === "a1:to:0")).toMatchObject({
      thread: "payments",
      channelId: pay,
      fromThread: "mira",
    });
    const ask = postAgentToChannel(
      state,
      actor("mira"),
      {
        channelId: pay,
        text: "@Theo can partial refunds exceed the captured amount?",
        question: true,
      },
      "a2",
      agent("a2", later(1)),
    );
    state = applyEvents(state, ask.events);
    expect(ask.result.wake).toEqual(["theo"]);
    expect(readChannel(state, pay).waiting).toEqual([
      {
        postId: "a2",
        threadId: "theo",
        askedBy: { kind: "thread", threadId: "mira" },
        since: later(1),
      },
    ]);
    const reply = postAgentToChannel(
      state,
      actor("theo"),
      { channelId: pay, text: "No, cap at the captured amount.", replyTo: "a2:to:0" },
      "a3",
      agent("a3", later(2)),
    );
    state = applyEvents(state, reply.events);
    expect(reply.result.post).toMatchObject({ recipients: ["mira"], replyTo: "a2" });
    expect(state.message?.find((row) => row.id === "a3:to:0")).toMatchObject({
      thread: "mira",
      replyTo: "a2:to:0",
    });
    expect(readChannel(state, pay).waiting).toEqual([]);
    // The lead posting without mentions reaches no one but stays in the transcript.
    const status = postAgentToChannel(
      state,
      actor("payments"),
      { channelId: pay, text: "Status: on track." },
      "a4",
      agent("a4", later(3)),
    );
    expect(status.result.post).toMatchObject({ recipients: [], messageIds: [] });
    expect(() =>
      postAgentToChannel(
        state,
        actor("sales-chat"),
        { channelId: pay, text: "Hello" },
        "a5",
        agent("a5"),
      ),
    ).toThrow("not_channel_member");
  });

  it("keeps the hop and rate limits of ordinary team messages", () => {
    let state = synced();
    // Mira's turn started from a message that already used every hop.
    state = applyEvents(state, [
      {
        eventId: "deep",
        aggregateType: "message",
        aggregateId: "deep",
        type: "message.created",
        occurredAt: at,
        payload: {
          id: "deep",
          thread: "mira",
          from: { kind: "agent", id: "writer" },
          to: [{ kind: "agent", id: "writer" }],
          kind: "message",
          expectsReply: false,
          priority: "normal",
          delivery: "next_turn",
          root: "deep",
          hops: teamHopLimit,
          ttlHops: teamHopLimit,
          origin: "agent",
          body: [{ type: "text", text: "x" }],
          createdAt: at,
        },
      } as DomainEvent,
      {
        eventId: "deep-item",
        aggregateType: "item",
        aggregateId: "deep-item",
        type: "item.created",
        occurredAt: at,
        payload: {
          id: "deep-item",
          threadId: "mira",
          turnId: "t-mira",
          kind: "user",
          seq: 1,
          body: { sourceMessageId: "deep" },
          createdAt: at,
          updatedAt: at,
        },
      } as DomainEvent,
    ]);
    expect(() =>
      postAgentToChannel(state, actor("mira"), { channelId: pay, text: "Hi" }, "h1", agent("h1")),
    ).toThrow("hop_limit_reached");
    let rate = synced();
    for (let index = 0; index < 10; index++)
      rate = applyEvents(
        rate,
        postAgentToChannel(
          rate,
          actor("theo"),
          { channelId: pay, text: `Note ${index}` },
          `r${index}`,
          agent(`r${index}`, later(index)),
        ).events,
      );
    expect(() =>
      postAgentToChannel(
        rate,
        actor("theo"),
        { channelId: pay, text: "One more" },
        "r10",
        agent("r10", later(11)),
      ),
    ).toThrow("rate_limited");
  });
});

describe("requests", () => {
  function requested() {
    let state = synced();
    state = applyEvents(
      state,
      postOwnerToChannel(
        state,
        { channelId: pay, postId: "p1", text: "Ship refunds by Friday." },
        human("post-1"),
      ).events,
    );
    // The lead's turn starts from the request, then it delegates to Mira.
    state = startTurn(state, "p1:to:0:input", "t-payments");
    const brief = briefTeam(
      state,
      actor("payments"),
      { brief: "Build the refund endpoint", chatId: "mira" },
      { childId: "mira", messageId: "brief-mira" },
      agent("brief-mira"),
    );
    return applyEvents(state, brief.events);
  }

  it("tags tasks the lead assigns with the request, and settles its state from them", () => {
    let state = requested();
    expect(state.task?.find((row) => row.id === "brief-mira:task")?.requestId).toBe("request-p1");
    state = applyEvents(state, settleChannelRequests(state, system("settle-1")).events);
    expect(state.channelRequest?.[0]?.state).toBe("running");
    expect(readChannel(state, pay).tasks.map((row) => row.id)).toEqual(["brief-mira:task"]);
    state = setTask(state, "brief-mira:task", { state: "completed" });
    state = applyEvents(state, settleChannelRequests(state, system("settle-2")).events);
    expect(state.channelRequest?.[0]).toMatchObject({ state: "done", revision: 3 });
    expect(settleChannelRequests(state, system("settle-3")).events).toEqual([]);
  });

  it("stops, resumes, reassigns, archives and restores a request", () => {
    let state = requested();
    state = applyEvents(state, settleChannelRequests(state, system("settle")).events);
    const revision = () => Number(state.channelRequest?.[0]?.revision);
    expect(() =>
      channelRequestAction(
        state,
        { id: "request-p1", action: "stop", revision: revision() },
        human("stop-1"),
      ),
    ).toThrow("confirmation_required");
    const stopped = channelRequestAction(
      state,
      { id: "request-p1", action: "stop", revision: revision(), confirmed: true },
      human("stop-2"),
    );
    expect(stopped.result.cancel).toEqual(["brief-mira:task"]);
    expect(stopped.result.wake).toEqual(["payments"]);
    state = applyEvents(state, stopped.events);
    expect(state.channelRequest?.[0]?.state).toBe("stopped");
    expect(state.message?.find((row) => row.id === "stop-2:notice")).toMatchObject({
      thread: "payments",
      requestId: "request-p1",
    });
    expect(() =>
      channelRequestAction(
        state,
        { id: "request-p1", action: "stop", revision: revision() - 1, confirmed: true },
        human("stale"),
      ),
    ).toThrow("stale_revision");
    for (const [action, expected, extra] of [
      ["resume", "open", {}],
      ["reassign", "open", { leadThreadId: "theo" }],
      ["archive", "archived", {}],
      ["restore", "open", {}],
    ] as const) {
      const out = channelRequestAction(
        state,
        { id: "request-p1", action, revision: revision(), ...extra },
        human(`act-${action}`),
      );
      state = applyEvents(state, out.events);
      expect(state.channelRequest?.[0]?.state).toBe(expected);
    }
    expect(state.channelRequest?.[0]?.leadThreadId).toBe("theo");
    expect(() =>
      channelRequestAction(
        state,
        { id: "request-p1", action: "reassign", revision: revision(), leadThreadId: "sales-chat" },
        human("bad-lead"),
      ),
    ).toThrow("lead_not_member");
  });

  it("drops a stopped request's questions from the waiting list", () => {
    let state = synced();
    state = applyEvents(
      state,
      postOwnerToChannel(state, { channelId: pay, postId: "q1", text: "Status?" }, human("q1"))
        .events,
    );
    expect(readChannel(state, pay).waiting.map((row) => row.threadId)).toEqual(["payments"]);
    state = applyEvents(
      state,
      channelRequestAction(
        state,
        { id: "request-q1", action: "stop", revision: 1 },
        human("stop-q1"),
      ).events,
    );
    expect(readChannel(state, pay).waiting).toEqual([]);
  });
});
