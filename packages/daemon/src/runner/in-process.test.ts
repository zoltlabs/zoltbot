import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import { handle } from "@zoltbot/core";
import type { AgentEvent as AdapterEvent, InteractionAnswer } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { referenceCapabilities } from "../../../../tools/fakes/src/capabilities.js";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { createInProcessRuntime } from "./in-process.js";
import type { RuntimeObservation } from "./index.js";

class Native implements AgentSession {
  readonly capabilities = referenceCapabilities;
  readonly nativeId = "native";
  readonly queue = new AsyncQueue<AdapterEvent>();
  sends = 0;
  constructor() {
    void this.queue.push({
      t: "session.ready",
      nativeId: this.nativeId,
      capabilities: this.capabilities,
      providerVersion: "fixture",
    });
  }
  events() {
    return this.queue;
  }
  async send() {
    this.sends++;
    await this.queue.push({ t: "turn.started", turnId: "native-turn" });
    await this.queue.push({
      t: "text.delta",
      turnId: "native-turn",
      itemId: "message",
      text: "safe seeded-",
    });
    await this.queue.push({
      t: "text.delta",
      turnId: "native-turn",
      itemId: "message",
      text: "secret tail",
    });
    await this.queue.push({
      t: "message.done",
      turnId: "native-turn",
      itemId: "message",
      text: "safe seeded-secret tail",
      phase: "final",
    });
    await this.queue.push({ t: "turn.done", turnId: "native-turn", status: "completed" });
    return { disposition: "started" as const };
  }
  async interrupt() {}
  async respond(_id: string, _answer: InteractionAnswer) {}
  async setModel() {}
  async setMode() {}
  async compact() {}
  async rename() {}
  async contextUsage() {
    return undefined;
  }
  async close() {
    this.queue.close();
  }
}

it("keeps native opens single-flight, streams normalized redacted events, and sends a durable turn once", async () => {
  const f = await runtimeFixture();
  const native = new Native();
  f.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  let opens = 0;
  const runtime = createInProcessRuntime({
    store: f.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: f.root,
          estimate: (text) => text.length,
          privateValues: ["seeded-secret"],
          async open() {
            opens++;
            return native;
          },
        };
      },
    },
  });
  const events: RuntimeObservation[] = [];
  const reader = (async () => {
    for await (const event of runtime.runner.events()) {
      events.push(event);
      if (event.event.t === "turn.done") break;
    }
  })();
  try {
    await Promise.all([
      runtime.runner.startSession({ threadId: "thread" }),
      runtime.runner.startSession({ threadId: "thread" }),
    ]);
    expect(opens).toBe(1);
    const turn = {
      threadId: "thread",
      commandId: "send",
      input: [{ type: "text" as const, text: "Synthetic input" }],
      mode: "queue" as const,
    };
    const first = await runtime.runner.sendTurn(turn);
    expect(await runtime.runner.sendTurn(turn)).toEqual(first);
    await expect.poll(() => events.some(({ event }) => event.t === "turn.done")).toBe(true);
    await reader;
    expect(native.sends).toBe(1);
    expect(events.every((event) => event.threadId === "thread" && event.sessionId)).toBe(true);
    expect(events.some((event) => event.event.t === "session.ready")).toBe(true);
    const deltas = events
      .flatMap(({ event }) => (event.t === "text.delta" ? [event.text] : []))
      .join("");
    expect(deltas).toBe("safe [redacted] tail");
    expect(JSON.stringify(events)).not.toContain("seeded-secret");
    expect(f.store.snapshot().item?.find((item) => item.kind === "message")?.body).toMatchObject({
      text: "safe [redacted] tail",
    });
  } finally {
    await runtime.runner.close();
    f.close();
  }
});

it("awaits durable observations without a stream reader and preserves redaction before persistence", async () => {
  const f = await runtimeFixture();
  const native = new Native();
  f.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  const persisted: RuntimeObservation[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createInProcessRuntime({
    store: f.store,
    publish() {},
    persistObservation: async (observation) => {
      persisted.push(observation);
      if (observation.event.t === "session.ready") await barrier;
    },
    host: {
      async prepare() {
        return {
          cwd: f.root,
          estimate: (text) => text.length,
          privateValues: ["seeded-secret"],
          async open() {
            return native;
          },
        };
      },
    },
  });
  try {
    const start = runtime.runner.startSession({ threadId: "thread" });
    await expect.poll(() => persisted.length).toBe(1);
    await native.queue.push({ t: "status", state: "ready" });
    expect(persisted).toHaveLength(1);
    release();
    await start;
    await expect.poll(() => persisted.some((value) => value.event.t === "status")).toBe(true);
    await runtime.runner.sendTurn({
      threadId: "thread",
      commandId: "durable-send",
      mode: "queue",
      input: [{ type: "text", text: "Synthetic input" }],
    });
    await expect.poll(() => persisted.some((value) => value.event.t === "turn.done")).toBe(true);
    expect(JSON.stringify(persisted).includes("seeded-secret")).toBe(false);
  } finally {
    release();
    await runtime.runner.close();
    f.close();
  }
});
