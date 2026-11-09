import { describe, expect, it } from "vitest";
import { messageSources } from "../chat/sources.js";
import type { ChatStatus } from "./activity.js";
import {
  belowScope,
  chatTitle,
  managerContext,
  memberStatus,
  queuedThreads,
  recentActivity,
  teamBelow,
  teamIndex,
  teamWork,
  threadName,
  unnamedManager,
  withinScope,
} from "./manager-view.js";

// Company → Marketing → Paid ads, plus Sales beside Marketing and a second company.
const teams = [
  { id: "marketing", projectId: "co", name: "Marketing", goal: "Grow", instructions: "Be bold" },
  { id: "paid", projectId: "co", parentId: "marketing", name: "Paid ads", goal: "Cheap clicks" },
  { id: "sales", projectId: "co", name: "Sales" },
  { id: "elsewhere", projectId: "other", name: "Other team" },
];
const index = teamIndex(teams);
const team = (id: string) => ({ type: "subproject", id });
const company = { type: "project" as const, id: "co" };
const marketing = { type: "subproject" as const, id: "marketing" };
const profiles = [
  { id: "lead", name: "Planner", instructions: "Plan first." },
  { id: "maker", name: "Video maker" },
];
const threads = [
  { id: "m-mkt", kind: "manager", title: "Manager", agentId: "lead", node: team("marketing") },
  { id: "m-paid", kind: "manager", title: "Manager", agentId: "lead", node: team("paid") },
  { id: "video", kind: "side", title: "Video creator", agentId: "maker", node: team("paid") },
  { id: "static", kind: "side", title: "Static creator", agentId: "maker", node: team("paid") },
  {
    id: "brainstorm",
    kind: "side",
    title: "Brainstorm",
    agentId: "maker",
    node: team("marketing"),
  },
  { id: "deal", kind: "side", title: "Deal desk", agentId: "maker", node: team("sales") },
  { id: "task", kind: "task", title: "A task", agentId: "maker", node: team("paid") },
  { id: "old", kind: "side", title: "Old", archived: true, node: team("paid") },
];

describe("withinScope", () => {
  it("walks parent teams up to the scope", () => {
    expect(withinScope(team("paid"), marketing, index)).toBe(true);
    expect(withinScope(team("marketing"), marketing, index)).toBe(true);
    expect(withinScope(team("sales"), marketing, index)).toBe(false);
    expect(withinScope(team("marketing"), { type: "subproject", id: "paid" }, index)).toBe(false);
  });
  it("puts every team of a workspace below it and nothing from another workspace", () => {
    expect(withinScope(team("paid"), company, index)).toBe(true);
    expect(withinScope({ type: "project", id: "co" }, company, index)).toBe(true);
    expect(withinScope(team("elsewhere"), company, index)).toBe(false);
    expect(withinScope({ type: "project", id: "co" }, marketing, index)).toBe(false);
  });
  it("ignores missing nodes, unknown teams and parent cycles", () => {
    expect(withinScope(undefined, company, index)).toBe(false);
    expect(withinScope(team("ghost"), marketing, index)).toBe(false);
    const loop = teamIndex([
      { id: "a", parentId: "b", projectId: "co" },
      { id: "b", parentId: "a", projectId: "co" },
    ]);
    expect(withinScope(team("a"), marketing, loop)).toBe(false);
  });
  it("excludes the scope itself when strictly below", () => {
    expect(belowScope(team("marketing"), marketing, index)).toBe(false);
    expect(belowScope(team("paid"), marketing, index)).toBe(true);
  });
});

it("orders the manager's starting context from workspace to profile, skipping blanks", () => {
  const layers = managerContext(
    { id: "co", name: "Company", goal: "Sell", instructions: "", constraints: "No spam" },
    [teams[0] ?? {}, teams[1] ?? {}],
    profiles[0],
  );
  expect(layers.map((layer) => `${layer.source}:${layer.name}`)).toEqual([
    "Workspace:Company",
    "Team:Marketing",
    "Team:Paid ads",
    "Profile:Planner",
  ]);
  expect(layers[0]?.parts).toEqual([
    { label: "Goal", value: "Sell" },
    { label: "Constraints", value: "No spam" },
  ]);
  expect(layers[3]?.parts).toEqual([{ label: "Instructions", value: "Plan first." }]);
});

it("marks a chat queued only when nothing more urgent applies", () => {
  const queued = queuedThreads([
    { kind: "user", threadId: "a", body: { queueState: "queued" } },
    { kind: "user", threadId: "b", body: { queueState: "queued" } },
    { kind: "user", threadId: "c", body: { queueState: "sent" } },
    { kind: "message", threadId: "d", body: { queueState: "queued" } },
  ]);
  expect([...queued].sort()).toEqual(["a", "b"]);
  const statuses = new Map<string, ChatStatus>([
    ["a", "working"],
    ["b", "done"],
  ]);
  expect(memberStatus("a", statuses, queued)).toBe("working");
  expect(memberStatus("b", statuses, queued)).toBe("queued");
  expect(memberStatus("c", statuses, queued)).toBe("idle");
});

it("lists sub-teams with their manager and rollup, then chats most urgent first", () => {
  const statuses = new Map<string, ChatStatus>([
    ["video", "working"],
    ["static", "needs_you"],
    ["brainstorm", "done"],
  ]);
  const below = teamBelow(marketing, {
    teams,
    threads,
    profiles,
    statuses,
    queued: new Set(["m-paid"]),
  });
  expect(below.teams).toEqual([
    {
      id: "paid",
      name: "Paid ads",
      path: [],
      managerName: "Planner",
      managerThreadId: "m-paid",
      status: "needs_you",
      // The queued manager is the team's lead, not one of its chats.
      counts: { needs_you: 1, working: 1, queued: 0, done: 0, idle: 0 },
    },
  ]);
  expect(below.chats.map((chat) => [chat.title, chat.status, chat.teamName])).toEqual([
    ["Static creator", "needs_you", "Paid ads"],
    ["Video creator", "working", "Paid ads"],
    ["Brainstorm", "done", ""],
  ]);
  const whole = teamBelow(company, { teams, threads, profiles, statuses, queued: new Set() });
  expect(whole.teams.map((row) => [row.name, row.path])).toEqual([
    ["Marketing", []],
    ["Paid ads", ["Marketing"]],
    ["Sales", []],
  ]);
  expect(whole.totalChats).toBe(4);
});

it("collects tasks and routines at the scope or below", () => {
  const work = teamWork(
    marketing,
    [
      { id: "t1", state: "review", node: team("paid"), updatedAt: "2" },
      { id: "t2", state: "running", node: team("marketing"), updatedAt: "1" },
      { id: "t3", state: "queued", node: team("sales"), createdAt: "1" },
      { id: "t4", state: "completed", node: team("paid"), updatedAt: "3", archived: true },
    ],
    [
      { id: "r1", template: { node: team("paid") }, paused: true, nextRunAt: "1" },
      { id: "r2", template: { node: team("marketing") }, paused: false, nextRunAt: "2" },
      { id: "r3", template: { node: team("sales") }, paused: false, nextRunAt: "0" },
    ],
    teams,
  );
  expect(work.counts).toEqual({ needs_you: 1, running: 1, queued: 0, done: 0 });
  expect(work.total).toBe(2);
  expect(work.routines.map((row) => row.id)).toEqual(["r2", "r1"]);
});

it("names managers by profile unless renamed", () => {
  expect(threadName(threads[0], profiles)).toBe("Planner");
  expect(threadName({ ...threads[0], title: "Head of growth" }, profiles)).toBe("Head of growth");
  expect(threadName(threads[2], profiles)).toBe("Video creator");
});

it("colours a team by its manager without counting the manager as a chat", () => {
  const below = teamBelow(company, {
    teams,
    threads,
    profiles,
    statuses: new Map<string, ChatStatus>([["m-mkt", "needs_you"]]),
    queued: new Set(),
  });
  const marketingRow = below.teams.find((row) => row.id === "marketing");
  expect(marketingRow?.status).toBe("needs_you");
  expect(marketingRow?.counts.needs_you).toBe(0);
  expect(Object.values(marketingRow?.counts ?? {}).reduce((sum, value) => sum + value, 0)).toBe(3);
});

it("titles an unnamed manager chat after its team", () => {
  expect(chatTitle(threads[0] ?? {}, "Marketing")).toBe("Marketing manager");
  expect(chatTitle({ ...threads[0], title: "" }, "Marketing")).toBe("Marketing manager");
  expect(chatTitle({ ...threads[0], title: "Head of growth" }, "Marketing")).toBe("Head of growth");
  expect(unnamedManager({ ...threads[0], title: "Head of growth" })).toBe(false);
  expect(chatTitle(threads[2] ?? {}, "Paid ads")).toBe("Video creator");
});

describe("recent activity and message sources", () => {
  const audits = [
    {
      id: "d1",
      action: "manager.delegate",
      target: "video",
      detail: { managerThreadId: "m-paid", messageId: "msg-1" },
      at: "2026-11-06T10:00:00.000Z",
    },
    {
      id: "r1",
      action: "team.report",
      target: "m-paid",
      detail: { fromThreadId: "video", managerThreadId: "m-paid", messageId: "msg-2" },
      at: "2026-11-06T11:00:00.000Z",
    },
    {
      id: "deal:delegation",
      action: "manager.delegate",
      target: "deal",
      detail: { managerThreadId: "elsewhere" },
      at: "2026-11-06T12:00:00.000Z",
    },
    { id: "x", action: "thread.create", target: "video", at: "2026-11-06T13:00:00.000Z" },
  ];
  const interactions = [
    { id: "i1", threadId: "static", state: "pending", createdAt: "2026-11-06T09:00:00.000Z" },
    { id: "i2", threadId: "deal", state: "pending", createdAt: "2026-11-06T09:30:00.000Z" },
  ];
  it("shows briefs, reports and requests for this manager and chats below, newest first", () => {
    const paid = { type: "subproject" as const, id: "paid" };
    expect(
      recentActivity(paid, "m-paid", { audits, interactions, threads, profiles, teams }).map(
        (entry) => [entry.kind, entry.text, entry.threadId],
      ),
    ).toEqual([
      ["report", "Report from Video creator", "m-paid"],
      ["delegate", "Briefed Video creator", "video"],
      ["needs_you", "Static creator needs you", "static"],
    ]);
    expect(
      recentActivity(marketing, "m-mkt", { audits, interactions, threads, profiles, teams })
        .map((entry) => entry.text)
        .slice(0, 2),
    ).toEqual(["Report from Video creator to Planner", "Planner briefed Video creator"]);
  });
  it("labels agent inputs by the audit that delivered them, with the legacy brief id", () => {
    const sources = messageSources(audits, threads, profiles);
    expect(sources.get("msg-1")?.label).toBe("From Planner (manager)");
    expect(sources.get("msg-2")?.label).toBe("Report from Video creator");
    expect(sources.get("deal:brief")).toEqual({ label: "From a manager" });
    expect(sources.size).toBe(3);
  });
  it("labels teammate messages as questions, updates or replies with a link to the sender", () => {
    const message = (id: string, detail: Record<string, unknown>) => ({
      id: `${id}:audit`,
      action: "team.message",
      target: "m-paid",
      detail: { fromThreadId: "video", messageId: id, ...detail },
      at: "2026-11-06T14:00:00.000Z",
    });
    const sources = messageSources(
      [
        message("q", { kind: "question" }),
        message("u", { kind: "update" }),
        message("a", { kind: "update", replyTo: "q0" }),
      ],
      threads,
      profiles,
    );
    expect(sources.get("q")).toEqual({ label: "Question from Video creator", threadId: "video" });
    expect(sources.get("u")?.label).toBe("Update from Video creator");
    expect(sources.get("a")?.label).toBe("Reply from Video creator");
  });
});
