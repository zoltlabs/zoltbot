import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import { handle } from "@zoltbot/core";
import { type AgentEvent, InteractionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { InteractionEngine } from "../../../packages/daemon/src/interaction-engine.js";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { referenceCapabilities } from "./capabilities.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("fixture_deadline");
}
async function fixture(omitTurn = false) {
  const test = await runtimeFixture(),
    events = new AsyncQueue<AgentEvent>(),
    counts = { sends: 0, closes: 0, replies: 0 };
  test.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  const native: AgentSession = {
    nativeId: "native",
    capabilities: referenceCapabilities,
    events: () => events,
    async send() {
      counts.sends++;
      return { disposition: "handled" };
    },
    async close() {
      counts.closes++;
      events.close();
    },
    async respond() {
      counts.replies++;
    },
    async interrupt() {},
    async setModel() {},
    async setMode() {},
    async compact() {},
    async rename() {},
    async contextUsage() {
      return undefined;
    },
  };
  let engine: InteractionEngine;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    interactions: async () => engine,
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open() {
            return native;
          },
        };
      },
    },
  });
  engine = new InteractionEngine({
    store: test.store,
    publish() {},
    host: manager.interactionHost,
  });
  const worker = await manager.ensure("thread");
  await events.push({
    t: "session.ready",
    nativeId: "native",
    providerVersion: "fixture",
    capabilities: referenceCapabilities,
  });
  await events.push({ t: "turn.started", turnId: "first" });
  await events.push({
    t: "interaction.requested",
    interaction: {
      id: "wire-question",
      nativeRef: "native-question",
      agentId: "profile",
      threadId: "thread",
      ...(omitTurn ? {} : { turnId: "first" }),
      type: "question",
      items: [{ id: "q", prompt: "Choose", options: [{ id: "yes", label: "Yes" }] }],
      chain: [],
      urgency: "blocking",
    },
  });
  await until(() => !!test.store.snapshot().interaction?.length);
  const request = parse(InteractionSchema, test.store.snapshot().interaction?.[0]);
  const answer = () =>
    engine.answer(
      request.id,
      request.version,
      {
        action: "accept",
        answers: { q: { options: ["yes"] } },
        by: { kind: "human", id: "owner" },
        at,
      },
      "answer:once",
      { kind: "human", id: "owner" },
    );
  return {
    ...test,
    events,
    native,
    counts,
    manager,
    worker,
    request,
    answer,
    async dispose() {
      await engine.stopTimers();
      await manager.close();
      test.close();
    },
  };
}
it("holds queued work until the native response acknowledgement even if its turn ends first", async () => {
  const test = await fixture();
  let release = () => {};
  test.native.respond = async () => {
    test.counts.replies++;
    await test.events.push({ t: "turn.done", turnId: "first", status: "completed" });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  let answering: ReturnType<typeof test.answer> | undefined;
  try {
    answering = test.answer();
    await until(() => test.store.snapshot().turn?.[0]?.status === "completed");
    test.queue("later", "later");
    await test.worker.wake();
    expect(test.counts.sends).toBe(0);
    release();
    await answering;
    await until(() => test.counts.sends === 1);
    expect(test.counts.replies).toBe(1);
    expect(test.counts.closes).toBe(0);
  } finally {
    release();
    await answering;
    await test.dispose();
  }
});
it("closes a failed response owner, preserves the saved answer, and never replays the native reply", async () => {
  const test = await fixture();
  test.native.respond = async () => {
    test.counts.replies++;
    throw new Error("synthetic-private-reply-error");
  };
  try {
    const result = await test.answer();
    expect(result.state).toBe("answered");
    expect(test.counts.closes).toBe(1);
    expect(test.store.snapshot().turn?.[0]?.status).toBe("interrupted");
    expect(await test.answer()).toEqual(result);
    expect(test.counts.replies).toBe(1);
    test.queue("later", "later");
    await test.worker.wake();
    expect(test.counts.sends).toBe(0);
    expect(
      test.store
        .snapshot()
        .item?.some(
          (row) => (row.body as Record<string, unknown>).code === "interaction_reply_failed",
        ),
    ).toBe(true);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-private-reply-error");
  } finally {
    await test.dispose();
  }
});
it("rejects an old response target without sending into or closing a later native turn", async () => {
  const test = await fixture();
  try {
    await test.events.push({ t: "turn.done", turnId: "first", status: "completed" });
    await until(() => test.store.snapshot().turn?.[0]?.status === "completed");
    await test.events.push({ t: "turn.started", turnId: "later" });
    await until(() => test.store.snapshot().turn?.some((row) => row.status === "running") === true);
    await expect(
      test.manager.interactionHost.respond(test.request, {
        action: "accept",
        answers: { q: { options: ["yes"] } },
        by: { kind: "human", id: "owner" },
        at,
      }),
    ).rejects.toThrow("interaction_turn_ended");
    expect(test.counts.replies).toBe(0);
    expect(test.counts.closes).toBe(0);
    expect(test.store.snapshot().turn?.filter((row) => row.status === "running")).toHaveLength(1);
  } finally {
    await test.dispose();
  }
});

it("binds native requests without a turn field to their observed owning turn", async () => {
  const test = await fixture(true);
  try {
    expect(test.request.turnId).toBe(test.store.snapshot().turn?.[0]?.id);
  } finally {
    await test.dispose();
  }
});

it("quarantines failed reply cleanup instead of opening another native writer", async () => {
  const test = await fixture();
  test.native.respond = async () => {
    throw new Error("synthetic-private-reply-error");
  };
  test.native.close = async () => {
    test.counts.closes++;
    test.events.close();
    throw new Error("synthetic-private-close-error");
  };
  try {
    expect((await test.answer()).state).toBe("answered");
    await expect(test.manager.ensure("thread")).rejects.toThrow("runtime_cleanup_required");
    expect(test.counts.closes).toBe(1);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-private");
  } finally {
    await expect(test.dispose()).rejects.toThrow("runtime_close_failed");
    test.close();
  }
});
