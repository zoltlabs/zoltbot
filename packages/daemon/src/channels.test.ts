import path from "node:path";
import { type Command, handle } from "@zoltbot/core";
import { openStore, type Store } from "@zoltbot/store";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { channelApi } from "./channel-service.js";
import { companySupervisor } from "./company-supervisor.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeTools } from "./runtime-tools.js";

/** A Payments team led by the fixture's chat ("thread"), with Mira and Theo, and a Sales chat. */
async function payments() {
  const f = await runtimeFixture();
  let n = 0;
  const change = (store: Store, command: Command) => {
    const commandId = `change:${++n}`;
    store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  change(f.store, {
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
  for (const [id, name] of [
    ["pay", "Payments"],
    ["sales", "Sales"],
  ])
    change(f.store, {
      type: "create",
      kind: "subproject",
      value: {
        id,
        projectId: "co",
        name,
        label: "Team",
        goal: "",
        instructions: "",
        depth: 1,
        archived: false,
        createdAt: at,
      },
    });
  change(f.store, {
    type: "update",
    kind: "thread",
    id: "thread",
    changes: {
      kind: "manager",
      title: "Payments",
      projectId: "co",
      node: { type: "subproject", id: "pay" },
    },
  });
  for (const [id, title, team] of [
    ["mira", "Mira", "pay"],
    ["theo", "Theo", "pay"],
    ["sales-chat", "Sam", "sales"],
  ] as const)
    change(f.store, {
      type: "create",
      kind: "thread",
      value: {
        id,
        agentId: "profile",
        projectId: "co",
        node: { type: "subproject", id: team },
        kind: "side",
        title,
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    });
  change(f.store, { type: "transition", kind: "session", id: "session", to: "ready" });
  change(f.store, { type: "transition", kind: "session", id: "session", to: "running" });
  change(f.store, {
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
  return f;
}
function contextFor(store: Store, woken: string[]) {
  return {
    store,
    privacy: new PrivateInputGuard({ store, publish() {} }),
    publish() {},
    async wake(id: string) {
      woken.push(id);
    },
  };
}
const lead = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
async function call(
  tools: ReturnType<typeof runtimeTools>,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = tools.tools.get(name);
  if (!tool) throw new Error(`missing_${name}`);
  return (await tool({ actor: lead, arguments: args, idempotencyKey: name })) as Record<
    string,
    unknown
  >;
}
/** The lead's runtime picked up a queued input in its running turn. */
function claim(store: Store, itemId: string) {
  const item = store.record("item", itemId);
  store.dispatch(`claim:${itemId}`, () => ({
    events: [
      {
        eventId: `claim:${itemId}:0`,
        commandId: `claim:${itemId}`,
        aggregateType: "item",
        aggregateId: itemId,
        type: "item.updated",
        occurredAt: at,
        payload: { ...item, turnId: "turn" },
      },
    ],
    result: {},
  }));
}
const pay = "channel-team-pay";

it("posts, routes, tags tasks with the request and stops them, across a restart", async () => {
  const f = await payments();
  const dbPath = path.join(f.root, "store.db");
  let store = f.store;
  try {
    const woken: string[] = [];
    const cancelled: string[] = [];
    const context = contextFor(store, woken);
    await companySupervisor(context, { now: () => at }).tick();
    const api = channelApi(context, {
      async cancelTask(id) {
        cancelled.push(id);
      },
    });
    const listed = (await api("channel.list", { projectId: "co" })) as { items: unknown[] };
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: pay,
        name: "payments",
        leadThreadId: "thread",
        memberThreadIds: ["thread", "mira", "theo"],
      }),
    ]);

    // The owner's post goes to the lead and starts a request.
    const posted = (await api(
      "channel.post",
      { channelId: pay, id: "p1", text: "Ship refunds by Friday." },
      "owner-post",
    )) as { request: { id: string } };
    expect(posted.request.id).toBe("request-p1");
    expect(woken).toEqual(["thread"]);
    // A retry with the same post id writes nothing new.
    const seq = store.lastSeq();
    await api("channel.post", { channelId: pay, id: "p1", text: "Ship refunds by Friday." }, "x");
    expect(store.lastSeq()).toBe(seq);

    // The lead handles it: delegates to Mira and asks Theo in the channel.
    claim(store, "p1:to:0:input");
    const tools = runtimeTools(context, { waitMs: 0 });
    await call(tools, "team_delegate", { key: "mira", brief: "Refund endpoint", chatId: "mira" });
    const task = (store.snapshot(["task"]).task ?? []).find((row) => row.threadId === "mira");
    expect(task?.requestId).toBe("request-p1");
    const asked = await call(tools, "team_message", {
      key: "ask-theo",
      channelId: pay,
      text: "@Theo can you write the refund tests once Mira is done?",
      question: true,
      replyTo: "p1:to:0",
    });
    expect(asked).toMatchObject({ to: ["Theo"], delivered: "queued" });
    expect(woken).toContain("theo");
    // Sam is not in #payments, so the lead's post reaches no one and stays in the transcript.
    const outsider = await call(tools, "team_message", {
      key: "status",
      channelId: pay,
      text: "@Sam status: on track",
    });
    expect(outsider).toMatchObject({ to: [] });

    await companySupervisor(context, { now: () => at }).tick();
    const read = await call(tools, "team_channels", { channelId: pay });
    expect(read).toMatchObject({
      name: "#payments",
      requests: [{ requestId: "request-p1", state: "running", tasks: [{ title: "Mira" }] }],
      waiting: [{ owes: "Theo", askedBy: "Payments" }],
    });
    expect((await call(tools, "team_channels", {})).channels).toEqual([
      expect.objectContaining({ channelId: pay, youLead: true }),
    ]);

    // Restart: channels and the request survive, and reconciling again writes nothing.
    store.close();
    store = await openStore(dbPath);
    const restarted = contextFor(store, woken);
    const before = store.lastSeq();
    await companySupervisor(restarted, { now: () => at }).tick();
    expect(store.lastSeq()).toBe(before);
    const again = channelApi(restarted, {
      async cancelTask(id) {
        cancelled.push(id);
      },
    });
    const view = (await again("channel.read", { id: pay })) as {
      requests: { revision: number; state: string }[];
      posts: unknown[];
    };
    expect(view.posts).toHaveLength(3);
    const revision = view.requests[0]?.revision as number;
    await expect(
      again("channel.request", { id: "request-p1", action: "stop", revision }, "stop-1"),
    ).rejects.toThrow("confirmation_required");
    const stopped = (await again(
      "channel.request",
      { id: "request-p1", action: "stop", revision, confirmed: true },
      "stop-2",
    )) as { state: string };
    expect(stopped.state).toBe("stopped");
    expect(cancelled).toEqual([String(task?.id)]);
    expect(
      (store.snapshot(["audit"]).audit ?? []).some(
        (row) => row.action === "channel.request.stop" && row.target === "request-p1",
      ),
    ).toBe(true);
  } finally {
    store.close();
    f.close();
  }
});

it("keeps channel members in step with the team", async () => {
  const f = await payments();
  try {
    const context = contextFor(f.store, []);
    await companySupervisor(context, { now: () => at }).tick();
    f.store.dispatch("archive-theo", (state) =>
      handle(
        state,
        { type: "update", kind: "thread", id: "theo", changes: { archived: true } },
        { commandId: "archive-theo", at, actor: { kind: "system", id: "test" } },
      ),
    );
    await companySupervisor(context, { now: () => "2026-10-28T12:05:00.000Z" }).tick();
    expect(f.store.record("channel", pay)?.memberThreadIds).toEqual(["thread", "mira"]);
  } finally {
    f.close();
  }
});
