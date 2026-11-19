import { teamWaitKey } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { applyEvents, type DomainState } from "./projectors.js";
import { briefTeam, messageTeam } from "./team.js";
import { readTeamWait, startTeamWait, teamRequests, wakeTeamWait } from "./team-wait.js";

const at = "2026-11-06T12:00:00Z";
const team = (id: string, name: string, depth: number, parentId?: string) => ({
  id,
  projectId: "co",
  ...(parentId ? { parentId } : {}),
  name,
  label: "Team",
  goal: "",
  instructions: "",
  depth,
  archived: false,
  createdAt: at,
});
const chat = (id: string, kind: string, node: string) => ({
  id,
  agentId: "writer",
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
function company(): DomainState {
  const threads = [
    chat("ceo", "manager", "co"),
    chat("payments", "manager", "pay"),
    chat("mira", "side", "pay"),
    chat("theo", "side", "pay"),
    chat("sales-chat", "side", "sales"),
  ];
  return {
    agent: [
      {
        id: "writer",
        definitionId: "claude",
        archived: false,
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
    subproject: [team("pay", "Payments", 1), team("sales", "Sales", 1)],
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
const agent = (id: string) => ({
  commandId: id,
  at,
  actor: { kind: "agent" as const, id: "writer" },
});
const system = (id: string, when = at) => ({
  commandId: id,
  at: when,
  actor: { kind: "system" as const, id: "test" },
});

function delegated() {
  let state = company();
  for (const [child, title] of [
    ["mira", "Refund endpoint"],
    ["theo", "Refund tests"],
  ] as const) {
    const out = briefTeam(
      state,
      actor("payments"),
      { brief: `Build ${title}`, chatId: child },
      { childId: child, messageId: `brief-${child}` },
      agent(`brief-${child}`),
    );
    state = applyEvents(state, out.events);
    const task = state.task?.find((t) => t.id === `brief-${child}:task`);
    state = applyEvents(state, [
      {
        eventId: `rename-${child}`,
        commandId: `rename-${child}`,
        aggregateType: "task",
        aggregateId: String(task?.id),
        type: "task.updated",
        occurredAt: at,
        payload: { ...task, title },
      },
    ]);
  }
  return state;
}
const setTask = (state: DomainState, id: string, taskState: string) => {
  const task = state.task?.find((t) => t.id === id);
  return applyEvents(state, [
    {
      eventId: `set-${id}-${taskState}`,
      commandId: `set-${id}-${taskState}`,
      aggregateType: "task",
      aggregateId: id,
      type: "task.updated",
      occurredAt: at,
      payload: { ...task, state: taskState },
    },
  ]);
};

it("waits only on work the chat delegated or manages", () => {
  const state = delegated();
  const out = startTeamWait(
    state,
    actor("payments"),
    { taskIds: ["brief-mira:task", "brief-theo:task"], note: "Then ask for review" },
    "wait-1",
    agent("wait-1"),
  );
  expect(out.result).toMatchObject({ status: "waiting", wait: { status: "waiting", revision: 1 } });
  const next = applyEvents(state, out.events);
  expect(readTeamWait(next, "payments")).toMatchObject({
    taskIds: ["brief-mira:task", "brief-theo:task"],
    fallbackAt: "2026-11-06T14:00:00.000Z",
  });
  expect(() =>
    startTeamWait(state, actor("payments"), { chatIds: ["sales-chat"] }, "w", agent("w")),
  ).toThrow("wait_outside_scope: sales-chat");
  expect(() =>
    startTeamWait(state, actor("mira"), { taskIds: ["brief-theo:task"] }, "w", agent("w")),
  ).toThrow("wait_outside_scope");
  // A manager can wait on a report's turn without a task.
  expect(
    startTeamWait(state, actor("payments"), { chatIds: ["mira"] }, "w2", agent("w2")).result,
  ).toMatchObject({ status: "waiting" });
  // The same key returns the saved wait instead of a new revision.
  expect(
    startTeamWait(next, actor("payments"), { taskIds: ["brief-mira:task"] }, "wait-1", agent("x"))
      .events,
  ).toHaveLength(0);
});

it("doesn't save a wait when everything already finished", () => {
  const state = setTask(delegated(), "brief-mira:task", "review");
  const out = startTeamWait(
    state,
    actor("payments"),
    { taskIds: ["brief-mira:task"] },
    "wait-done",
    agent("wait-done"),
  );
  expect(out.events).toHaveLength(0);
  expect(out.result).toMatchObject({ status: "finished" });
});

it("wakes once with a structured notice, and only the owner can wake it early", () => {
  let state = delegated();
  state = applyEvents(
    state,
    startTeamWait(state, actor("payments"), { taskIds: ["brief-mira:task"] }, "w", agent("w"))
      .events,
  );
  expect(() => wakeTeamWait(state, "payments", "w", "owner", system("early"))).toThrow(
    "human_input_required",
  );
  state = setTask(state, "brief-mira:task", "review");
  const woken = wakeTeamWait(state, "payments", "w", "finished", system("fire"));
  state = applyEvents(state, woken.events);
  expect(readTeamWait(state, "payments")).toMatchObject({ status: "woken", reason: "finished" });
  const notice = state.item?.find((i) => i.id === "company:signal:wait:w:1:input");
  expect(notice?.body).toMatchObject({
    origin: "system",
    queueState: "queued",
    notice: { kind: "wait", waitId: "w", state: "finished" },
  });
  expect(JSON.stringify(notice?.body)).toContain(
    'Task brief-mira:task \\"Refund endpoint\\": review',
  );
  expect(wakeTeamWait(state, "payments", "w", "finished", system("again")).events).toHaveLength(0);
  expect(state.settings?.filter((r) => r.key === teamWaitKey("payments"))).toHaveLength(1);
});

it("lists what a chat sent and whether each is open, answered or done", () => {
  let state = delegated();
  const ask = messageTeam(
    state,
    actor("payments"),
    { text: "Can refunds exceed the capture?", to: "mira", kind: "question" },
    "q1",
    agent("q1"),
  );
  state = applyEvents(state, ask.events);
  const queued = state.item?.find((i) => i.id === "q1:input");
  expect(queued?.body).toMatchObject({
    notice: {
      kind: "team",
      type: "question",
      messageId: "q1",
      fromThreadId: "payments",
      preview: "Can refunds exceed the capture?",
    },
  });
  let rows = teamRequests(state, "payments");
  expect(rows.map((r) => [r.messageId, r.type, r.status])).toEqual(
    expect.arrayContaining([
      ["q1", "question", "open"],
      ["brief-mira", "assignment", "open"],
      ["brief-theo", "assignment", "open"],
    ]),
  );
  expect(rows.find((r) => r.messageId === "q1")?.text).toBe("Can refunds exceed the capture?");
  state = applyEvents(
    state,
    messageTeam(state, actor("mira"), { text: "No, cap it.", replyTo: "q1" }, "a1", agent("a1"))
      .events,
  );
  state = setTask(state, "brief-theo:task", "completed");
  rows = teamRequests(state, "payments");
  expect(rows.find((r) => r.messageId === "q1")).toMatchObject({
    status: "answered",
    replies: 1,
    lastReply: "No, cap it.",
  });
  expect(rows.find((r) => r.messageId === "brief-theo")).toMatchObject({
    status: "done",
    taskState: "completed",
  });
  expect(teamRequests(state, "payments", { open: true }).map((r) => r.messageId)).not.toContain(
    "brief-theo",
  );
});
