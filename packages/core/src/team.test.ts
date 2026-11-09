import { expect, it } from "vitest";
import { applyEvents, type DomainState } from "./projectors.js";
import {
  briefTeam,
  managerAbove,
  managerCanRead,
  messageTeam,
  reportUp,
  scopeContains,
  teamHopLimit,
  teamMessageRate,
  workspaceChats,
} from "./team.js";

const at = "2026-11-06T12:00:00Z";
const team = (id: string, name: string, depth: number, parentId?: string) => ({
  id,
  projectId: "co",
  ...(parentId ? { parentId } : {}),
  name,
  label: "Team",
  goal: `${name} goal`,
  instructions: "",
  depth,
  archived: false,
  createdAt: at,
});
const chat = (id: string, kind: string, node: string, agentId = "writer") => ({
  id,
  agentId,
  projectId: "co",
  node: node === "co" ? { type: "project", id: "co" } : { type: "subproject", id: node },
  kind,
  title: id,
  titleSource: "human",
  pinned: false,
  archived: false,
  createdAt: at,
  lastActivityAt: at,
});
/** Company → Marketing → Paid ads, plus Sales and an Ops team with no manager. */
function company(): DomainState {
  const threads = [
    chat("ceo", "manager", "co"),
    chat("marketing", "manager", "mkt"),
    chat("paid", "manager", "paid"),
    chat("video", "side", "paid"),
    chat("sales-chat", "side", "sales"),
    chat("ops-chat", "side", "ops"),
    chat("strong", "side", "paid", "admin"),
  ];
  return {
    agent: [
      {
        id: "writer",
        definitionId: "claude",
        archived: false,
        permissionProfile: "workspace_write",
      },
      { id: "admin", definitionId: "codex", archived: false, permissionProfile: "full_access" },
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
    subproject: [
      team("mkt", "Marketing", 1),
      team("paid", "Paid ads", 2, "mkt"),
      team("sales", "Sales", 1),
      team("ops", "Ops", 1),
    ],
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
const actor = (thread: string, agentId = "writer") => ({
  agentId,
  threadId: thread,
  sessionId: `s-${thread}`,
  turnId: `t-${thread}`,
});
const context = (id: string, agentId = "writer") => ({
  commandId: id,
  at,
  actor: { kind: "agent" as const, id: agentId },
});

it("knows which teams sit below which", () => {
  const state = company();
  const node = (id: string) => ({ type: "subproject", id });
  expect(scopeContains(state, { type: "project", id: "co" }, node("paid"))).toBe(true);
  expect(scopeContains(state, node("mkt"), node("paid"))).toBe(true);
  expect(scopeContains(state, node("mkt"), node("mkt"))).toBe(true);
  expect(scopeContains(state, node("paid"), node("mkt"))).toBe(false);
  expect(scopeContains(state, node("mkt"), node("sales"))).toBe(false);
});

it("finds the nearest manager above, skipping teams without one", () => {
  const state = company();
  expect(managerAbove(state, "video")?.id).toBe("paid");
  expect(managerAbove(state, "paid")?.id).toBe("marketing");
  expect(managerAbove(state, "marketing")?.id).toBe("ceo");
  expect(managerAbove(state, "ops-chat")?.id).toBe("ceo");
  expect(managerAbove(state, "ceo")).toBeUndefined();
});

it("lets a manager read anything below it and nothing beside or above it", () => {
  const state = company();
  expect(managerCanRead(state, "marketing", "video")).toBe(true);
  expect(managerCanRead(state, "marketing", "paid")).toBe(true);
  expect(managerCanRead(state, "ceo", "sales-chat")).toBe(true);
  expect(managerCanRead(state, "marketing", "sales-chat")).toBe(false);
  expect(managerCanRead(state, "paid", "marketing")).toBe(false);
  expect(managerCanRead(state, "video", "paid")).toBe(false);
  expect(managerCanRead(state, "marketing", "marketing")).toBe(false);
});

it("lets a manager start a chat in a team below it, but not in a sibling team", () => {
  const state = company();
  const out = briefTeam(
    state,
    actor("marketing"),
    { title: "Static ads", brief: "Make three static ads", teamId: "paid" },
    { childId: "static", messageId: "static:brief" },
    context("brief-static"),
  );
  const next = applyEvents(state, out.events);
  expect(next.thread?.find((row) => row.id === "static")).toMatchObject({
    kind: "side",
    node: { type: "subproject", id: "paid" },
    agentId: "writer",
  });
  expect(next.message?.find((row) => row.id === "static:brief")).toMatchObject({
    hops: 1,
    ttlHops: teamHopLimit,
    kind: "task",
  });
  expect(next.audit?.find((row) => row.action === "manager.delegate")).toMatchObject({
    target: "static",
    detail: { managerThreadId: "marketing", messageId: "static:brief", existing: false },
  });
  expect(() =>
    briefTeam(
      state,
      actor("marketing"),
      { title: "Leads", brief: "Call leads", teamId: "sales" },
      { childId: "leads", messageId: "leads:brief" },
      context("brief-leads"),
    ),
  ).toThrow("team_outside_scope");
});

it("lets a manager brief an existing chat or a lower manager, within its permissions", () => {
  const state = company();
  const out = briefTeam(
    state,
    actor("marketing"),
    { brief: "Shift budget to video this week", chatId: "paid" },
    { childId: "unused", messageId: "m1" },
    context("brief-paid"),
  );
  const next = applyEvents(state, out.events);
  expect(next.thread).toHaveLength(state.thread?.length ?? 0);
  const input = next.item?.find((row) => row.threadId === "paid");
  expect(input?.body).toMatchObject({
    origin: "agent",
    sourceMessageId: "m1",
    queueState: "queued",
  });
  expect(JSON.stringify(input?.body)).toContain("Brief from Marketing manager");
  expect(out.result).toMatchObject({ childId: "paid", existing: true });
  expect(() =>
    briefTeam(
      state,
      actor("marketing"),
      { brief: "Close the deal", chatId: "sales-chat" },
      { childId: "x", messageId: "m2" },
      context("brief-sales"),
    ),
  ).toThrow("chat_outside_team");
  expect(() =>
    briefTeam(
      state,
      actor("marketing"),
      { brief: "Deploy it", chatId: "strong" },
      { childId: "x", messageId: "m3" },
      context("brief-strong"),
    ),
  ).toThrow("delegation_permission_widening");
  expect(() =>
    briefTeam(
      state,
      actor("video"),
      { brief: "Help", chatId: "paid" },
      { childId: "x", messageId: "m4" },
      context("brief-up"),
    ),
  ).toThrow("manager_scope_required");
});

it("routes a report to the nearest manager and labels it as a teammate's information", () => {
  const state = company();
  const out = reportUp(state, actor("video"), { text: "Cut 1 is ready" }, "r1", context("report"));
  const next = applyEvents(state, out.events);
  expect(out.result).toMatchObject({ managerThreadId: "paid" });
  const input = next.item?.find((row) => row.threadId === "paid");
  expect(JSON.stringify(input?.body)).toContain('Report from \\"video\\" in Paid ads');
  expect(next.audit?.find((row) => row.action === "team.report")).toMatchObject({
    target: "paid",
    detail: { fromThreadId: "video", managerThreadId: "paid", messageId: "r1" },
  });
  const up = reportUp(state, actor("paid"), { text: "Week summary" }, "r2", context("report-2"));
  expect(up.result).toMatchObject({ managerThreadId: "marketing" });
  expect(() =>
    reportUp(state, actor("ceo"), { text: "Anyone?" }, "r3", context("report-3")),
  ).toThrow("no_manager_above");
  expect(() =>
    reportUp(state, { ...actor("video"), turnId: "ended" }, { text: "x" }, "r4", context("r4")),
  ).toThrow("active_turn_required");
});

it("stops two agents from keeping each other busy past the hop limit", () => {
  const state = company();
  let current = state;
  let hops = 0;
  let managerTurn = "t-paid";
  // Each round: the manager briefs the video chat, whose next turn reports back.
  for (let round = 0; ; round++) {
    const brief = `b${round}`;
    try {
      current = applyEvents(
        current,
        briefTeam(
          current,
          { ...actor("paid"), turnId: managerTurn },
          { brief: "Again", chatId: "video" },
          { childId: "x", messageId: brief },
          context(`brief-${round}`),
        ).events,
      );
    } catch (error) {
      expect(String(error)).toContain("hop_limit_reached");
      break;
    }
    hops = Number(current.message?.find((row) => row.id === brief)?.hops);
    // The video chat's next turn starts from that brief.
    current = linkTurn(current, "video", brief, `vt${round}`);
    const report = `r${round}`;
    try {
      current = applyEvents(
        current,
        reportUp(
          current,
          { ...actor("video"), turnId: `vt${round}` },
          { text: "Done" },
          report,
          context(`report-${round}`),
        ).events,
      );
    } catch (error) {
      expect(String(error)).toContain("hop_limit_reached");
      break;
    }
    hops = Number(current.message?.find((row) => row.id === report)?.hops);
    managerTurn = `pt${round}`;
    current = linkTurn(current, "paid", report, managerTurn);
    if (round > 20) throw new Error("no_limit");
  }
  expect(hops).toBe(teamHopLimit);
});

it("lists the chats a chat can message, nearest first, inside its workspace only", () => {
  const state = company();
  state.thread?.push(
    { ...chat("elsewhere", "side", "co"), projectId: "other" },
    { ...chat("old", "side", "paid"), archived: true },
    { ...chat("fork", "side", "paid"), fork: { sourceThreadId: "video" } },
  );
  const rows = workspaceChats(state, "video");
  expect(rows.slice(0, 2)).toEqual([
    { id: "paid", title: "Paid ads manager", team: "Paid ads", relation: "your_manager" },
    { id: "strong", title: "strong", team: "Paid ads", relation: "same_team" },
  ]);
  expect(rows.map((row) => row.id)).not.toContain("video");
  expect(rows.map((row) => row.id)).not.toContain("elsewhere");
  expect(rows.map((row) => row.id)).not.toContain("old");
  expect(rows.map((row) => row.id)).not.toContain("fork");
  expect(workspaceChats(state, "video", "SALES-CHAT").map((row) => row.id)).toEqual(["sales-chat"]);
});

it("lets peers on different teams ask and answer, and the answer returns to the asker", () => {
  let state = company();
  const ask = messageTeam(
    state,
    actor("video"),
    { text: "Which layout did you pick?", to: "sales-chat", kind: "question" },
    "q1",
    context("ask"),
  );
  expect(ask.result).toMatchObject({ to: "sales-chat", wake: true });
  state = applyEvents(state, ask.events);
  expect(state.message?.find((row) => row.id === "q1")).toMatchObject({
    thread: "sales-chat",
    fromThread: "video",
    expectsReply: true,
    hops: 1,
  });
  const input = state.item?.find((row) => row.threadId === "sales-chat");
  expect(JSON.stringify(input?.body)).toContain("Question from");
  expect(JSON.stringify(input?.body)).toContain("not a human instruction");
  state = linkTurn(state, "sales-chat", "q1", "st1");
  const reply = messageTeam(
    state,
    { ...actor("sales-chat"), turnId: "st1" },
    { text: "The two-column one", replyTo: "q1" },
    "a1",
    context("answer"),
  );
  expect(reply.result).toMatchObject({ to: "video", wake: true });
  state = applyEvents(state, reply.events);
  expect(state.message?.find((row) => row.id === "a1")).toMatchObject({
    thread: "video",
    replyTo: "q1",
    root: "q1",
    hops: 2,
  });
  expect(state.audit?.find((row) => row.id === "a1:audit")).toMatchObject({
    action: "team.message",
    detail: { fromThreadId: "sales-chat", toThreadId: "video", replyTo: "q1" },
  });
  // A second answer to the same question, and an answer to an answer, do not wake anyone.
  const again = messageTeam(
    state,
    { ...actor("sales-chat"), turnId: "st1" },
    { text: "Also the dark variant", replyTo: "q1" },
    "a2",
    context("answer-2"),
  );
  expect(again.result).toMatchObject({ wake: false });
  state = linkTurn(state, "video", "a1", "vt1");
  const thanks = messageTeam(
    state,
    { ...actor("video"), turnId: "vt1" },
    { text: "Thanks", replyTo: "a1" },
    "a3",
    context("thanks"),
  );
  expect(thanks.result).toMatchObject({ to: "sales-chat", wake: false });
});

it("sends updates without waking, and defaults to the nearest manager", () => {
  const state = company();
  const out = messageTeam(state, actor("video"), { text: "Checks passed" }, "u1", context("u"));
  expect(out.result).toMatchObject({ to: "paid", wake: false });
  const next = applyEvents(state, out.events);
  expect(next.message?.find((row) => row.id === "u1")).toMatchObject({ expectsReply: false });
  expect(JSON.stringify(next.item?.find((row) => row.threadId === "paid")?.body)).toContain(
    "No reply needed",
  );
  expect(() => messageTeam(state, actor("ceo"), { text: "Anyone?" }, "u2", context("u2"))).toThrow(
    "no_manager_above",
  );
});

it("refuses other workspaces, itself, unknown replies and answers to someone else's message", () => {
  const state = company();
  state.thread?.push({ ...chat("elsewhere", "side", "co"), projectId: "other" });
  const send = (input: Parameters<typeof messageTeam>[2], who = "video") =>
    messageTeam(state, actor(who), input, `m-${Math.random()}`, context("m"));
  expect(() => send({ text: "Hi", to: "elsewhere" })).toThrow("chat_outside_workspace");
  expect(() => send({ text: "Hi", to: "video" })).toThrow("chat_unavailable");
  expect(() => send({ text: "Hi", to: "missing" })).toThrow("chat_unavailable");
  expect(() => send({ text: "Hi", replyTo: "missing" })).toThrow("reply_not_found");
  const asked = applyEvents(
    state,
    messageTeam(state, actor("video"), { text: "Q", to: "sales-chat" }, "q", context("q")).events,
  );
  // Only the chat that received a message can answer it.
  expect(() =>
    messageTeam(asked, actor("ops-chat"), { text: "A", replyTo: "q" }, "a", context("a")),
  ).toThrow("reply_not_found");
});

it("limits how often one chat can message the same chat", () => {
  let state = company();
  for (let i = 0; i < teamMessageRate; i++)
    state = applyEvents(
      state,
      messageTeam(
        state,
        actor("video"),
        { text: `n${i}`, to: "sales-chat" },
        `r${i}`,
        context(`r${i}`),
      ).events,
    );
  expect(() =>
    messageTeam(state, actor("video"), { text: "one more", to: "sales-chat" }, "rx", context("rx")),
  ).toThrow("rate_limited");
  expect(
    messageTeam(state, actor("video"), { text: "other chat", to: "ops-chat" }, "ry", context("ry"))
      .result,
  ).toMatchObject({ to: "ops-chat" });
});

/** Marks the input queued for a message as the start of a new running turn on that thread. */
function linkTurn(state: DomainState, threadId: string, messageId: string, turnId: string) {
  const sessionId = `s-${threadId}`;
  const turn = (state.turn ?? []).map((row) =>
    row.threadId === threadId ? { ...row, status: "completed" } : row,
  );
  turn.push({ id: turnId, sessionId, threadId, status: "running" });
  const item = (state.item ?? []).map((row) =>
    (row.body as { sourceMessageId?: string })?.sourceMessageId === messageId
      ? { ...row, turnId }
      : row,
  );
  return { ...state, turn, item } as DomainState;
}
