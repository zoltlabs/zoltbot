import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

type Fixture = Awaited<ReturnType<typeof compareFixture>>;
type Row = Record<string, unknown>;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const text = (value: string) => [{ type: "text", text: value }];
const system = { kind: "system", id: "e2e" };

/** Writes synthetic rows straight into the fixture daemon's store, before the shell connects. */
function seed(fixture: Fixture, rows: [kind: string, id: string, row: Row][]) {
  const store = fixture.daemon.store;
  rows.forEach(([kind, id, row], index) => {
    const commandId = `seed:${kind}:${id}`;
    const exists = store.record(kind, id) !== undefined;
    const at = minutesAgo(0);
    store.dispatch(commandId, () => ({
      events: [
        {
          eventId: `${commandId}:${index}`,
          commandId,
          aggregateType: kind,
          aggregateId: id,
          type: `${kind}.${exists ? "updated" : "created"}`,
          occurredAt: at,
          payload: exists ? { ...store.record(kind, id), ...row } : row,
        },
      ],
      result: {},
    }));
  });
}

const chat = (id: string, title: string): [string, string, Row] => [
  "thread",
  id,
  {
    id,
    agentId: "profile",
    kind: "side",
    title,
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: minutesAgo(60),
    lastActivityAt: minutesAgo(30),
  },
];
const assignment = (id: string, to: string, at: string): [string, string, Row] => [
  "message",
  id,
  {
    id,
    thread: to,
    fromThread: "thread",
    from: { kind: "agent", id: "profile" },
    to: [{ kind: "agent", id: "profile" }],
    kind: "task",
    expectsReply: true,
    priority: "normal",
    delivery: "next_turn",
    root: id,
    hops: 1,
    ttlHops: 4,
    origin: "agent",
    body: text("[Assignment from Payments]\nPlease take this on."),
    createdAt: at,
  },
];
const task = (id: string, row: Row): [string, string, Row] => [
  "task",
  id,
  {
    id,
    rootId: id,
    brief: "Synthetic brief",
    acceptance: "",
    expectedDeliverable: "",
    workspaceMode: "shared",
    revision: 1,
    attempt: 1,
    maxAttempts: 3,
    reviewRequired: true,
    executionLocation: "local",
    accountableThreadId: "thread",
    createdBy: system,
    createdAt: minutesAgo(40),
    updatedAt: minutesAgo(40),
    ...row,
  },
];
const item = (id: string, seq: number, row: Row): [string, string, Row] => [
  "item",
  id,
  { id, threadId: "thread", seq, createdAt: minutesAgo(40), updatedAt: minutesAgo(40), ...row },
];

/**
 * A manager chat ("Payments") that assigned three tasks in one turn: one running against a
 * budget, one waiting on it and one ready for review. It also asked Theo a question, gets a
 * supervision notice and waits on its open work.
 */
function payments(fixture: Fixture) {
  seed(fixture, [
    ["thread", "thread", { title: "Payments", kind: "manager" }],
    chat("mira", "Mira"),
    chat("theo", "Theo"),
    [
      "turn",
      "delegate-turn",
      {
        id: "delegate-turn",
        sessionId: "session",
        threadId: "thread",
        status: "completed",
        origin: "human",
        startedAt: minutesAgo(45),
        endedAt: minutesAgo(38),
      },
    ],
    item("ask", 1, {
      turnId: "delegate-turn",
      kind: "user",
      createdAt: minutesAgo(45),
      body: { input: text("Ship partial refunds"), origin: "human", queueState: "handled" },
    }),
    assignment("brief-endpoint", "mira", minutesAgo(41)),
    assignment("brief-docs", "mira", minutesAgo(40)),
    assignment("brief-tests", "theo", minutesAgo(40)),
    item("plan", 2, {
      turnId: "delegate-turn",
      kind: "message",
      phase: "final",
      createdAt: minutesAgo(39),
      body: { text: "I split the refund work between Mira and Theo." },
    }),
    task("endpoint", {
      title: "Add refund endpoint",
      threadId: "mira",
      sourceMessageId: "brief-endpoint",
      state: "running",
      budgetUsd: 2,
      createdAt: minutesAgo(41),
    }),
    task("docs", {
      title: "Document refunds",
      threadId: "mira",
      sourceMessageId: "brief-docs",
      state: "queued",
      dependencies: ["endpoint"],
      createdAt: minutesAgo(40.5),
    }),
    task("tests", {
      title: "Write refund tests",
      threadId: "theo",
      sourceMessageId: "brief-tests",
      state: "review",
      updatedAt: minutesAgo(10),
    }),
    [
      "usage",
      "usage-endpoint",
      {
        id: "usage-endpoint",
        sessionId: "session",
        taskId: "endpoint",
        costUsd: 0.6,
        costKnown: true,
        injectedTokens: 0,
        recordedAt: minutesAgo(20),
      },
    ],
    [
      "turn",
      "endpoint-turn",
      {
        id: "endpoint-turn",
        sessionId: "session",
        threadId: "mira",
        status: "completed",
        origin: "agent",
        startedAt: minutesAgo(38),
        endedAt: minutesAgo(30),
      },
    ],
    [
      "taskResult",
      "tests",
      {
        taskId: "tests",
        revision: 1,
        status: "done",
        summary: "Added refund tests",
        files: ["src/refunds.test.ts", "src/fixtures/refunds.json"],
        digest: "",
        auto: false,
        createdAt: minutesAgo(10),
      },
    ],
    item("supervision", 3, {
      kind: "user",
      createdAt: minutesAgo(10),
      body: {
        input: text("[Task update] Write refund tests is ready for review."),
        origin: "system",
        queueState: "handled",
        notice: { kind: "supervision", taskId: "tests", state: "review" },
      },
    }),
    item("note", 4, {
      kind: "message",
      phase: "final",
      createdAt: minutesAgo(9),
      body: { text: "Theo's tests cover full and partial refunds." },
    }),
    [
      "message",
      "question",
      {
        id: "question",
        thread: "theo",
        fromThread: "thread",
        from: { kind: "agent", id: "profile" },
        to: [{ kind: "agent", id: "profile" }],
        kind: "message",
        expectsReply: true,
        priority: "normal",
        delivery: "next_turn",
        root: "question",
        hops: 1,
        ttlHops: 4,
        origin: "agent",
        body: text("[Message from Payments]\nDo the tests cover refunds in other currencies?"),
        createdAt: minutesAgo(8),
      },
    ],
    // The owner's follow-ups: one waiting in the queue and one that failed to send.
    item("follow-up", 5, {
      kind: "user",
      createdAt: minutesAgo(6),
      body: { input: text("Also cover refunds in yen"), origin: "human", queueState: "queued" },
    }),
    item("retry", 6, {
      kind: "user",
      createdAt: minutesAgo(5),
      body: { input: text("Check the refund limits"), origin: "human", queueState: "failed" },
    }),
    [
      "settings",
      "team.wait.thread",
      {
        key: "team.wait.thread",
        value: {
          id: "wait-refunds",
          threadId: "thread",
          taskIds: ["endpoint", "tests"],
          chatIds: [],
          status: "waiting",
          revision: 1,
          fallbackAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: minutesAgo(7),
          updatedAt: minutesAgo(7),
        },
      },
    ],
  ]);
}

test("a manager's chat shows assigned work, results and waits, and acts on them", async ({
  page,
}) => {
  const fixture = await compareFixture();
  payments(fixture);
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Payments(?: |$)/ }).click();

    // One delegation card for the turn that assigned the work.
    const assigned = page.getByRole("region", { name: "Assigned tasks" });
    await expect(assigned).toHaveCount(1);
    await expect(assigned.getByRole("heading", { name: "Assigned 3 tasks" })).toBeVisible();
    const rows = assigned.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Add refund endpoint");
    await expect(rows.nth(0)).toContainText("Mira · Running");
    await expect(rows.nth(0)).toContainText("$0.60 of $2");
    await expect(rows.nth(1)).toContainText("Waits on Add refund endpoint");
    await expect(rows.nth(2)).toContainText("Theo · Ready for review");
    await expect(assigned.getByRole("button", { name: "Stop Write refund tests" })).toHaveCount(0);

    // The result card, the supervision notice, the sent question and the wait line.
    const result = page.getByRole("region", { name: "Write refund tests" });
    await expect(result).toContainText("src/refunds.test.ts, src/fixtures/refunds.json");
    await expect(result).toContainText("Theo's tests cover full and partial refunds.");
    await expect(result.getByText("Ready for review", { exact: true })).toBeVisible();
    await expect(page.getByText("finished", { exact: true })).toBeVisible();
    await expect(page.getByText("Do the tests cover refunds in other currencies?")).toBeVisible();
    await expect(page.getByText("· waiting for a reply")).toBeVisible();
    await expect(page.getByText("is waiting for", { exact: true })).toBeVisible();
    await expect(page.getByText("2 tasks", { exact: true })).toBeVisible();
    await expect(page.locator(".message-status")).toHaveText(["Queued #1", "Failed"]);

    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("manager-cards.png"), fullPage: true });

    // Wake now ends the wait before its work finishes.
    await page.getByRole("button", { name: "Wake now", exact: true }).click();
    await expect
      .poll(
        () =>
          (fixture.daemon.store.record("settings", "team.wait.thread")?.value as Row | undefined)
            ?.status,
      )
      .toBe("woken");
    await expect(page.getByRole("button", { name: "Wake now", exact: true })).toHaveCount(0);

    // Stop asks first; Keep leaves the task running.
    await assigned.getByRole("button", { name: "Stop Add refund endpoint" }).click();
    await expect(assigned.getByText("Stop this task?")).toBeVisible();
    await assigned.getByRole("button", { name: "Keep", exact: true }).click();
    expect(fixture.daemon.store.record("task", "endpoint")?.state).toBe("running");
    await assigned.getByRole("button", { name: "Stop Add refund endpoint" }).click();
    await assigned.getByRole("button", { name: "Stop task", exact: true }).click();
    await expect(rows.nth(0)).toContainText("Mira · Stopped");
    await expect
      .poll(() => fixture.daemon.store.record("task", "endpoint")?.state)
      .toBe("cancelled");

    // Accept shows at once and reaches the daemon.
    await result.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(result.getByText("Accepted", { exact: true })).toBeVisible();
    await expect.poll(() => fixture.daemon.store.record("task", "tests")?.state).toBe("completed");
    await expect(result.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);

    // Open goes to the teammate's chat.
    await result.getByRole("button", { name: "Open Theo's chat", exact: true }).click();
    await expect(page.getByRole("region", { name: "Assigned tasks" })).toHaveCount(0);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
