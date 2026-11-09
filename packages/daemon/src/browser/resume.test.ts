import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import type { AgentEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { referenceCapabilities } from "../../../../tools/fakes/src/capabilities.js";
import { runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { Redactor } from "../logging.js";
import { RuntimeWorker } from "../runtime-worker.js";

it("ignores restored usage for an unowned prior native turn and continues the resumed conversation", async () => {
  const f = await runtimeFixture();
  const events = new AsyncQueue<AgentEvent>();
  const errors: string[] = [];
  const session = {
    capabilities: referenceCapabilities,
    nativeId: "native",
    events: () => events,
    close: async () => events.close(),
    send: async () => ({ disposition: "started" as const }),
  } as unknown as AgentSession;
  const worker = new RuntimeWorker({
    store: f.store,
    session,
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor(),
    estimate: () => 1,
    publish() {},
    onError: (code) => errors.push(code),
  });
  try {
    worker.start();
    await events.push({
      t: "session.ready",
      nativeId: "native",
      capabilities: referenceCapabilities,
      providerVersion: "fixture",
    });
    await expect.poll(() => f.store.record("session", "session")?.state).toBe("ready");
    await events.push({
      t: "usage.updated",
      turnId: "previous-native-turn",
      usage: { inputTokens: 100, cumulative: false },
    });
    await events.push({ t: "turn.started", turnId: "new-native-turn" });
    await events.push({
      t: "usage.updated",
      turnId: "new-native-turn",
      usage: { inputTokens: 7, cumulative: false },
    });
    await events.push({ t: "turn.done", turnId: "new-native-turn", status: "completed" });
    await expect.poll(() => f.store.snapshot(["usage"]).usage?.[0]?.inputTokens).toBe(7);
    expect(f.store.snapshot(["usage"]).usage).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await worker.close();
    f.close();
  }
});
