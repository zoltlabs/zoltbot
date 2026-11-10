import { type Command, handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { markTaint } from "./knowledge-taint.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeTools } from "./runtime-tools.js";

/** Company → Marketing → Paid ads. "thread" is the Marketing manager; "paid" manages Paid ads. */
async function company() {
  const f = await runtimeFixture();
  let n = 0;
  const change = (command: Command) => {
    const commandId = `change:${++n}`;
    f.store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  change({
    type: "create",
    kind: "project",
    value: {
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
  });
  for (const [id, name, depth, parentId] of [
    ["mkt", "Marketing", 1, undefined],
    ["paid", "Paid ads", 2, "mkt"],
  ] as const)
    change({
      type: "create",
      kind: "subproject",
      value: {
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
      },
    });
  change({
    type: "update",
    kind: "thread",
    id: "thread",
    changes: { kind: "manager", projectId: "co", node: { type: "subproject", id: "mkt" } },
  });
  for (const [id, kind] of [
    ["paid-manager", "manager"],
    ["video", "side"],
  ] as const)
    change({
      type: "create",
      kind: "thread",
      value: {
        id,
        agentId: "profile",
        projectId: "co",
        node: { type: "subproject", id: "paid" },
        kind,
        title: id === "video" ? "Video creator" : "Manager",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    });
  change({ type: "transition", kind: "session", id: "session", to: "ready" });
  change({ type: "transition", kind: "session", id: "session", to: "running" });
  change({
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  const woken: string[] = [];
  const tools = runtimeTools(
    {
      store: f.store,
      privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
      publish() {},
      async wake(id: string) {
        woken.push(id);
      },
    },
    { waitMs: 0 },
  );
  return { f, change, tools, woken };
}
const manager = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };

it("briefs an existing chat two teams down and a new chat in a lower team", async () => {
  const { f, tools, woken } = await company();
  try {
    const delegate = tools.tools.get("team_delegate");
    if (!delegate) throw new Error("missing_tool");
    expect(tools.authorize(manager, "team_read_thread", { childId: "video" })).toBe(true);
    const existing = (await delegate({
      actor: manager,
      arguments: { key: "cut", brief: "Cut a 15s version", chatId: "video" },
      idempotencyKey: "a",
    })) as { childId: string; status: string };
    expect(existing).toMatchObject({ childId: "video", status: "queued" });
    const seq = f.store.lastSeq();
    expect(
      await delegate({
        actor: manager,
        arguments: { key: "cut", brief: "Cut a 15s version", chatId: "video" },
        idempotencyKey: "retry",
      }),
    ).toEqual(existing);
    expect(f.store.lastSeq()).toBe(seq);
    const fresh = (await delegate({
      actor: manager,
      arguments: { key: "static", title: "Static ads", brief: "Three static ads", teamId: "paid" },
      idempotencyKey: "b",
    })) as { childId: string };
    expect(f.store.snapshot(["thread"]).thread?.find((r) => r.id === fresh.childId)).toMatchObject({
      node: { type: "subproject", id: "paid" },
      kind: "side",
    });
    expect(woken).toEqual([]); // Task runner owns dispatch, including after retries.
    expect(f.store.snapshot(["task"]).task).toHaveLength(2);
    await expect(
      delegate({
        actor: manager,
        arguments: { key: "none", brief: "No target" },
        idempotencyKey: "c",
      }),
    ).rejects.toThrow("title_or_chat_required");
  } finally {
    f.close();
  }
});

it("only offers reporting to chats with a manager above, and refuses inactive reporters", async () => {
  const { f, tools } = await company();
  try {
    // The Marketing manager has nobody above it in this workspace.
    expect(tools.authorize(manager, "team_report", { key: "k", text: "t" })).toBe(false);
    // The video chat has a manager, but no running turn, so the dispatcher refuses it.
    expect(
      tools.authorize(
        { agentId: "profile", threadId: "video", sessionId: "session", turnId: "turn" },
        "team_report",
        { key: "k", text: "t" },
      ),
    ).toBe(false);
    expect(tools.authorize(manager, "team_read_thread", { childId: "missing" })).toBe(false);
  } finally {
    f.close();
  }
});

it("delivers a report from a working chat to its team manager and wakes it", async () => {
  const { f, change, tools, woken } = await company();
  try {
    change({
      type: "create",
      kind: "session",
      value: {
        id: "s-video",
        threadId: "video",
        provider: "fake",
        cwd: "/tmp",
        state: "starting",
        capabilities: {},
        startedAt: at,
      },
    });
    change({ type: "transition", kind: "session", id: "s-video", to: "ready" });
    change({ type: "transition", kind: "session", id: "s-video", to: "running" });
    change({
      type: "create",
      kind: "turn",
      value: {
        id: "t-video",
        sessionId: "s-video",
        threadId: "video",
        status: "running",
        origin: "human",
        startedAt: at,
      },
    });
    const video = {
      agentId: "profile",
      threadId: "video",
      sessionId: "s-video",
      turnId: "t-video",
    };
    expect(tools.authorize(video, "team_report", {})).toBe(true);
    expect(tools.authorize(video, "team_delegate", {})).toBe(true);
    const report = tools.tools.get("team_report");
    if (!report) throw new Error("missing_tool");
    expect(
      await report({
        actor: video,
        arguments: { key: "r", text: "Cut 1 ready" },
        idempotencyKey: "r",
      }),
    ).toEqual({ delivered: "queued", managerThreadId: "paid-manager" });
    expect(woken).toEqual(["paid-manager"]);
    const state = f.store.snapshot(["item", "audit"]);
    expect(
      state.item?.find((row) => row.threadId === "paid-manager" && row.kind === "user")?.body,
    ).toMatchObject({ origin: "agent", queueState: "queued" });
    expect(state.audit?.some((row) => row.action === "team.report")).toBe(true);
    await expect(
      report({ actor: video, arguments: { key: "r", text: "Changed" }, idempotencyKey: "r2" }),
    ).rejects.toThrow("command_receipt_conflict");
  } finally {
    f.close();
  }
});

it("writes learned entries from a report through the knowledge write policy", async () => {
  const { f, change, tools } = await company();
  try {
    change({
      type: "create",
      kind: "session",
      value: {
        id: "s-video",
        threadId: "video",
        provider: "fake",
        cwd: "/tmp",
        state: "starting",
        capabilities: {},
        startedAt: at,
      },
    });
    change({ type: "transition", kind: "session", id: "s-video", to: "ready" });
    change({ type: "transition", kind: "session", id: "s-video", to: "running" });
    change({
      type: "create",
      kind: "turn",
      value: {
        id: "t-video",
        sessionId: "s-video",
        threadId: "video",
        status: "running",
        origin: "human",
        startedAt: at,
      },
    });
    const report = tools.tools.get("team_report");
    if (!report) throw new Error("missing_tool");
    const result = (await report({
      actor: { agentId: "profile", threadId: "video", sessionId: "s-video", turnId: "t-video" },
      arguments: {
        key: "cut",
        text: "Cut 1 ready",
        learned: [
          {
            kind: "lesson",
            title: "Captions burn in",
            body: "Export captions burned in for the ad network.",
            evidence: [{ kind: "thread", ref: "video" }],
          },
          { kind: "lesson", title: "No evidence" },
        ],
      },
      idempotencyKey: "cut",
    })) as { delivered: string; learned: { result: string; why: string }[] };
    expect(result.delivered).toBe("queued");
    expect(result.learned.map((row) => row.result)).toEqual(["applied", "rejected"]);
    expect(
      f.store.snapshot(["knowledge"]).knowledge?.find((row) => row.title === "Captions burn in"),
    ).toMatchObject({ verification: "unverified", writer: { kind: "agent" } });
    expect(
      f.store.database
        .prepare("SELECT count(*) AS n FROM knowledge_writes_aux WHERE source='learned'")
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

it("messages a chat by title, lists chats for an unknown name, and keeps tainted chats to updates", async () => {
  const { f, tools, woken } = await company();
  try {
    expect(tools.authorize(manager, "team_message", {})).toBe(true);
    const send = tools.tools.get("team_message");
    if (!send) throw new Error("missing_tool");
    const asked = (await send({
      actor: manager,
      arguments: { key: "q", text: "Which cut is final?", to: "video creator", question: true },
      idempotencyKey: "q",
    })) as { messageId: string; to: string; delivered: string };
    expect(asked).toMatchObject({ to: "video", delivered: "queued" });
    expect(woken).toEqual(["video"]);
    expect(f.store.record("message", asked.messageId)).toMatchObject({
      thread: "video",
      fromThread: "thread",
      expectsReply: true,
    });
    const update = await send({
      actor: manager,
      arguments: { key: "u", text: "Budget approved", to: "paid-manager" },
      idempotencyKey: "u",
    });
    expect(update).toMatchObject({ to: "paid-manager", delivered: "queued" });
    expect(woken).toEqual(["video"]);
    expect(
      await send({
        actor: manager,
        arguments: { key: "x", text: "Hi", to: "video team" },
        idempotencyKey: "x",
      }),
    ).toMatchObject({
      error: "chat_not_found",
      chats: [
        { id: "video", title: "Video creator", relation: "same_workspace" },
        { id: "paid-manager" },
      ],
      total: 2,
    });
    // The Marketing manager has nobody above it, so a message with no recipient is refused.
    expect(
      await send({ actor: manager, arguments: { key: "y", text: "Hi" }, idempotencyKey: "y" }),
    ).toEqual({ error: "no_manager_above" });
    markTaint(f.store, "session", "outside_workspace", "web page");
    expect(
      await send({
        actor: manager,
        arguments: { key: "z", text: "Deploy now", to: "video", question: true },
        idempotencyKey: "z",
      }),
    ).toMatchObject({ error: "question_not_allowed" });
  } finally {
    f.close();
  }
});
