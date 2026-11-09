import { expect, it } from "vitest";
import {
  ago,
  chatStatuses,
  mostRecentProject,
  rowStatuses,
  scopeLabel,
  sharedFolders,
  threadProject,
  threadProvider,
} from "./activity.js";

const now = new Date("2026-11-02T15:00:00");
const local = (time: string) => new Date(`2026-11-02T${time}`).toISOString();

it("ranks a pending request over a running turn and only counts turns finished in the last day", () => {
  const statuses = chatStatuses(
    {
      thread: ["asks", "busy", "finished", "lateNight", "yesterday", "fresh"].map((id) => ({ id })),
      interaction: [
        { threadId: "asks", state: "pending" },
        { threadId: "busy", state: "answered" },
      ],
      turn: [
        { threadId: "asks", status: "running", startedAt: local("14:00:00") },
        {
          threadId: "busy",
          status: "completed",
          startedAt: local("13:00:00"),
          endedAt: local("13:05:00"),
        },
        { threadId: "busy", status: "running", startedAt: local("14:30:00") },
        { threadId: "finished", status: "interrupted", startedAt: local("09:00:00") },
        {
          threadId: "finished",
          status: "completed",
          startedAt: local("10:00:00"),
          endedAt: local("10:10:00"),
        },
        {
          threadId: "lateNight",
          status: "completed",
          startedAt: "2026-11-01T22:00:00",
          endedAt: "2026-11-01T22:30:00",
        },
        {
          threadId: "yesterday",
          status: "completed",
          startedAt: "2026-11-01T10:00:00Z",
          endedAt: "2026-11-01T10:05:00Z",
        },
      ],
    },
    now,
  );
  expect(Object.fromEntries(statuses)).toEqual({
    asks: "needs_you",
    busy: "working",
    finished: "done",
    lateNight: "done",
    yesterday: "idle",
    fresh: "idle",
  });
});

it("names a thread's place from its project down to the nested area", () => {
  const projects = [{ id: "p", name: "Zolt Product" }],
    directions = [
      { id: "food", projectId: "p", name: "Food pipeline" },
      { id: "barcode", projectId: "p", parentId: "food", name: "Barcode matching" },
    ];
  expect(scopeLabel({ node: { type: "subproject", id: "barcode" } }, projects, directions)).toBe(
    "Zolt Product › Food pipeline › Barcode matching",
  );
  expect(scopeLabel({ node: { type: "project", id: "p" } }, projects, directions)).toBe(
    "Zolt Product",
  );
  expect(scopeLabel({}, projects, directions)).toBe("");
  expect(threadProject({ node: { type: "subproject", id: "barcode" } }, directions)).toBe("p");
  expect(threadProject({ projectId: "imported" }, directions)).toBe("imported");
});

it("flags folders that two chats have open, ignoring closed sessions", () => {
  expect(
    sharedFolders([
      { threadId: "a", cwd: "/repo", state: "running" },
      { threadId: "b", cwd: "/repo", state: "ready" },
      { threadId: "a", cwd: "/repo", state: "ready" },
      { threadId: "c", cwd: "/other", state: "ready" },
      { threadId: "d", cwd: "/other", state: "closed" },
    ]),
  ).toEqual([{ cwd: "/repo", threadIds: ["a", "b"] }]);
});

it("uses the newest session's provider and short relative times", () => {
  expect(
    threadProvider(
      [
        { threadId: "a", provider: "claude", startedAt: local("09:00:00") },
        { threadId: "a", provider: "codex", startedAt: local("10:00:00") },
      ],
      "a",
    ),
  ).toBe("codex");
  expect(ago(local("14:56:00"), now)).toBe("4 min ago");
  expect(ago(local("12:00:00"), now)).toBe("3 h ago");
  expect(ago(local("14:59:50"), now)).toBe("just now");
});

it("opens the workspace whose chats were active last, falling back to the newest workspace", () => {
  const projects = [
    { id: "old", createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "busy", createdAt: "2026-10-02T00:00:00.000Z" },
    { id: "new", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: "gone", createdAt: "2026-11-05T00:00:00.000Z", archived: true },
  ];
  const directions = [{ id: "team", projectId: "busy" }];
  const threads = [
    { id: "a", node: { type: "project", id: "old" }, lastActivityAt: "2026-10-20T00:00:00.000Z" },
    {
      id: "b",
      node: { type: "subproject", id: "team" },
      lastActivityAt: "2026-11-03T00:00:00.000Z",
    },
    { id: "c", node: { type: "project", id: "gone" }, lastActivityAt: "2026-11-06T00:00:00.000Z" },
  ];
  expect(mostRecentProject(projects, threads, directions)?.id).toBe("busy");
  expect(mostRecentProject(projects, [], directions)?.id).toBe("new");
  expect(mostRecentProject([], threads, directions)).toBeUndefined();
});

it("puts approvals before questions and shows Done or Failed only until the chat is opened", () => {
  const rows = rowStatuses(
    {
      thread: ["a", "q", "run", "done", "read", "bad"].map((id) => ({ id })),
      interaction: [
        { threadId: "a", state: "pending", type: "question" },
        { threadId: "a", state: "pending", type: "approval" },
        { threadId: "q", state: "pending", type: "question" },
      ],
      turn: [
        { threadId: "run", status: "running", startedAt: "2026-11-07T10:00:00Z" },
        {
          threadId: "done",
          status: "completed",
          startedAt: "2026-11-07T09:00:00Z",
          endedAt: "2026-11-07T09:05:00Z",
        },
        {
          threadId: "read",
          status: "completed",
          startedAt: "2026-11-07T09:00:00Z",
          endedAt: "2026-11-07T09:05:00Z",
        },
        {
          threadId: "bad",
          status: "failed",
          startedAt: "2026-11-07T09:00:00Z",
          endedAt: "2026-11-07T09:01:00Z",
        },
      ],
    },
    { read: "2026-11-07T09:06:00Z" },
  );
  expect(Object.fromEntries(rows)).toEqual({
    a: "approval",
    q: "input",
    run: "working",
    done: "done",
    read: "idle",
    bad: "failed",
  });
});
