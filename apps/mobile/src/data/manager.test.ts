import { describe, expect, it } from "vitest";
import { delegationSpend, managerRows, noticeFor, noticeText, rowMeta } from "./manager.js";
import { transcript } from "./timeline.js";
import type { Row, Snapshot } from "./transport.js";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 15, minute)).toISOString();
const snapshot = (entities: Record<string, Row[]>): Snapshot =>
  ({ seq: 1, entities, counters: {} }) as unknown as Snapshot;
const thread = (id: string, title: string, agentId: string): Row => ({
  id,
  title,
  agentId,
  archived: false,
});
const item = (id: string, threadId: string, seq: number, kind: string, body: Row, extra = {}) => ({
  id,
  threadId,
  seq,
  kind,
  body,
  createdAt: at(seq),
  updatedAt: at(seq),
  ...extra,
});

function managerChat(): Snapshot {
  return snapshot({
    thread: [
      thread("mira", "Mira", "lead"),
      thread("sam", "Sam", "dev"),
      thread("theo", "Theo", "qa"),
    ],
    turn: [{ id: "turn-1", threadId: "mira", startedAt: at(1), endedAt: at(9) }],
    item: [
      item("ask", "mira", 1, "user", { input: [{ type: "text", text: "Ship the EU tax fix." }] }),
      item("plan", "mira", 2, "message", { text: "I'll split it in two." }, { turnId: "turn-1" }),
      item("after", "mira", 20, "message", { text: "Covers both rounding paths." }),
    ],
    message: [
      {
        id: "brief-1",
        fromThread: "mira",
        thread: "sam",
        kind: "task",
        body: [],
        createdAt: at(3),
      },
      {
        id: "brief-2",
        fromThread: "mira",
        thread: "theo",
        kind: "task",
        body: [],
        createdAt: at(4),
      },
      {
        id: "tip",
        fromThread: "mira",
        thread: "theo",
        kind: "message",
        body: [{ type: "text", text: "[Mira → Theo]\nuse the EU fixtures" }],
        createdAt: at(12),
      },
    ],
    task: [
      {
        id: "t-sam",
        title: "Fix checkout tax rounding",
        state: "running",
        threadId: "sam",
        sourceMessageId: "brief-1",
        revision: 1,
        budgetUsd: 2,
        createdAt: at(3),
        updatedAt: at(3),
      },
      {
        id: "t-theo",
        title: "Add invoice rounding test",
        state: "review",
        threadId: "theo",
        sourceMessageId: "brief-2",
        revision: 1,
        budgetUsd: 2,
        createdAt: at(4),
        updatedAt: at(18),
      },
    ],
    session: [{ id: "s-sam", threadId: "sam" }],
    usage: [
      { id: "u1", sessionId: "s-sam", costUsd: 0.5 },
      { id: "u2", sessionId: "x", taskId: "t-theo", costUsd: 0.23 },
    ],
    taskResult: [{ taskId: "t-theo", revision: 1, files: ["invoice.test.ts"], createdAt: at(18) }],
    deliverable: [{ id: "d1", taskId: "t-theo", version: 1, validationState: "passed" }],
    settings: [
      {
        key: "team.wait.mira",
        value: {
          id: "wait-1",
          status: "waiting",
          taskIds: ["t-sam"],
          chatIds: [],
          updatedAt: at(21),
        },
      },
    ],
  });
}

describe("manager chat", () => {
  it("adds a delegation card after the turn, a sent message, a result and the wait", () => {
    const rows = transcript(managerChat(), "mira");
    expect(rows.map((row) => row.id)).toEqual([
      "ask",
      "plan",
      "card:delegation:turn-1",
      "notice:sent:tip",
      "after",
      "card:result:t-theo",
      "notice:waiting:wait-1",
    ]);
    const delegation = rows[2]?.manager;
    expect(delegation?.kind).toBe("delegation");
    if (delegation?.kind !== "delegation") return;
    expect(delegation.rows.map((row) => [row.title, row.owner.name, row.status])).toEqual([
      ["Fix checkout tax rounding", "Sam", "running"],
      ["Add invoice rounding test", "Theo", "review"],
    ]);
    expect(delegationSpend(delegation.rows)).toBe("$0.73 of $4");
    expect(rows[3]?.text).toBe("Mira → Theo: use the EU fixtures");
    expect(rows[6]?.text).toBe("Waiting on Fix checkout tax rounding");
    expect(rows[6]?.notice).toMatchObject({ threadId: "mira", waitId: "wait-1" });
  });

  it("builds the result card from the result, its checks and the manager's next words", () => {
    const result = transcript(managerChat(), "mira").find((row) =>
      row.id.startsWith("card:result"),
    );
    expect(result?.manager).toMatchObject({
      kind: "result",
      title: "Add invoice rounding test",
      files: ["invoice.test.ts"],
      tests: "passed",
      note: "Covers both rounding paths.",
      manager: "Mira",
      owner: { name: "Theo", threadId: "theo" },
    });
  });

  it("shows no result card until the task is in review", () => {
    const data = managerChat();
    for (const task of data.entities.task ?? []) task.state = "running";
    expect(managerRows(data, "mira").some((entry) => entry.row.id.startsWith("card:result"))).toBe(
      false,
    );
  });

  it("reads a teammate's message in the recipient's chat as one line", () => {
    const data = managerChat();
    const incoming = item("in-1", "theo", 1, "user", {
      origin: "agent",
      input: [{ type: "text", text: "[Mira → Theo]\nuse the EU fixtures" }],
      notice: { kind: "team", messageId: "tip", fromThreadId: "mira", type: "update" },
    });
    expect(noticeText(noticeFor(data, incoming) ?? { kind: "team", text: "" })).toBe(
      "Mira → Theo: use the EU fixtures",
    );
    data.entities.item = [incoming];
    const [row] = transcript(data, "theo");
    expect(row?.kind).toBe("other");
    expect(row?.notice?.kind).toBe("team");
  });

  it("puts a supervision notice before the [Zoltbot] event check", () => {
    const data = managerChat();
    data.entities.item = [
      item("sup", "mira", 1, "user", {
        input: [{ type: "text", text: "[Zoltbot] Theo finished a task." }],
        notice: { kind: "supervision", taskId: "t-theo", state: "review" },
      }),
    ];
    const [row] = transcript(data, "mira");
    expect(row?.event).toBeUndefined();
    expect(row?.text).toBe("Theo finished Add invoice rounding test · ready for review");
  });

  it("says the state and the age of each assigned task", () => {
    const now = Date.parse(at(7));
    expect(
      rowMeta(
        {
          taskId: "t",
          revision: 1,
          owner: { name: "Sam", threadId: "sam", agentId: "dev" },
          title: "Fix",
          status: "running",
          startedAt: at(3),
        },
        now,
      ),
    ).toBe("Running · 4 min");
    expect(
      rowMeta(
        {
          taskId: "t",
          revision: 1,
          owner: { name: "Sam", threadId: "sam", agentId: "dev" },
          title: "Fix",
          status: "queued",
          reason: "Waits on Refund endpoint",
        },
        now,
      ),
    ).toBe("Queued · Waits on Refund endpoint");
  });
});
