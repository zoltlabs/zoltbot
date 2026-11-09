import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { type Command, handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeToolDefinitions, runtimeTools } from "./runtime-tools.js";

it("keeps delegation scoped, attributed, bounded and idempotent across retries", async () => {
  const f = await runtimeFixture();
  let n = 0,
    wakes = 0;
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
      id: "zolt",
      name: "Zolt",
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
  change({
    type: "update",
    kind: "thread",
    id: "thread",
    changes: { kind: "manager", projectId: "zolt", node: { type: "project", id: "zolt" } },
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
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const tools = runtimeTools(
    {
      store: f.store,
      privacy,
      publish() {},
      async wake() {
        wakes++;
      },
    },
    { waitMs: 0 },
  );
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  const call = {
    actor,
    arguments: { key: "food-units", title: "Food units", brief: "Check grams and ounces" },
    idempotencyKey: "call",
  };
  try {
    const delegate = tools.tools.get("team_delegate");
    if (!delegate) throw new Error("missing_tool");
    const first = (await delegate(call)) as { childId: string; link: string; status: string };
    expect(first).toMatchObject({ status: "queued", link: `#chat/${first.childId}` });
    const seq = f.store.lastSeq();
    expect(await delegate({ ...call, idempotencyKey: "different-native-retry" })).toEqual(first);
    expect(f.store.lastSeq()).toBe(seq);
    expect(f.store.snapshot(["thread"]).thread).toHaveLength(2);
    expect(wakes).toBe(2);
    await expect(
      delegate({ ...call, arguments: { ...call.arguments, brief: "Changed" } }),
    ).rejects.toThrow("command_receipt_conflict");
    expect(tools.authorize({ ...actor, threadId: first.childId }, "team_delegate", {})).toBe(false);
    expect(tools.authorize(actor, "team_read_thread", { childId: "unrelated" })).toBe(false);
    privacy.remember("synthetic-private-credential");
    await expect(
      delegate({
        ...call,
        arguments: { ...call.arguments, key: "secret", brief: "synthetic-private-credential" },
      }),
    ).rejects.toThrow();
    expect(f.store.snapshot(["thread"]).thread).toHaveLength(2);
    expect(JSON.stringify(f.store.snapshot())).not.toContain("synthetic-private-credential");
    expect(
      referenceTokenEstimate(runtimeToolDefinitions.map((tool) => tool.description).join("\n")),
    ).toBeLessThan(700);
    expect(referenceTokenEstimate(JSON.stringify(runtimeToolDefinitions))).toBeLessThan(1150);
  } finally {
    f.close();
  }
});
