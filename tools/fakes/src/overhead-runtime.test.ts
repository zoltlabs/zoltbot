import { Redactor } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { RuntimeWorker } from "../../../packages/daemon/src/runtime-worker.js";
import { ReferenceSession } from "./reference-adapter.js";
import { runtimeFixture } from "./runtime-fixture.js";

it("persists known added context even when the provider never reports usage", async () => {
  const fixture = await runtimeFixture();
  const native = await new ReferenceSession({
    identity: { agentId: "profile", threadId: "thread" },
    mode: "new",
    cwd: fixture.root,
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
  }).open();
  const worker = new RuntimeWorker({
    store: fixture.store,
    session: native,
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor(),
    estimate: (text) => text.length,
    fixedInjectedTokens: 17,
    publish() {},
  });
  try {
    fixture.queue("message", "no usage sample");
    worker.start();
    await worker.wake();
    await expect.poll(() => fixture.store.snapshot().turn?.[0]?.status).toBe("completed");
    const state = fixture.store.snapshot();
    expect(state.usage).toHaveLength(1);
    expect(state.usage?.[0]).toMatchObject({
      turnId: state.turn?.[0]?.id,
      sessionId: "session",
      injectedTokens: 17,
      costKnown: false,
    });
    expect(state.usage?.[0]?.inputTokens).toBeUndefined();
    expect(state.usage?.[0]?.costUsd).toBeUndefined();
    const events = fixture.store.eventsSince(0);
    const usageEvent = events.find((event) => event.type === "usage.created");
    const turnEvent = events.find((event) => event.type === "turn.created");
    expect(usageEvent?.commandId).toBeTruthy();
    expect(usageEvent?.commandId).toBe(turnEvent?.commandId);
    fixture.store.rebuild();
    expect(fixture.store.snapshot()).toEqual(state);
  } finally {
    await worker.close();
    await native.close();
    fixture.close();
  }
});
