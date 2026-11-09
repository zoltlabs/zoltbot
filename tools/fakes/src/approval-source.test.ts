import path from "node:path";
import { AsyncQueue } from "@zoltbot/adapters-sdk";
import { Redactor, RuntimeWorker } from "@zoltbot/daemon";
import type { AgentEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { referenceCapabilities } from "./capabilities.js";
import { runtimeFixture } from "./runtime-fixture.js";

it("keeps native approval source paths separate from redacted display data", async () => {
  const test = await runtimeFixture();
  const events = new AsyncQueue<AgentEvent>();
  const received: { event: AgentEvent; paths?: readonly string[] }[] = [];
  let sends = 0;
  const worker = new RuntimeWorker({
    store: test.store,
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor([test.root]),
    estimate: (text) => text.length,
    publish() {},
    session: {
      events: () => events,
      async send() {
        sends++;
        return { disposition: "started" };
      },
      async close() {
        events.close();
      },
    },
    interaction: (event, paths) => {
      received.push({ event, ...(paths ? { paths } : {}) });
    },
  });
  try {
    test.queue("input", "synthetic");
    worker.start();
    await events.push({
      t: "session.ready",
      nativeId: "native",
      providerVersion: "fixture",
      capabilities: referenceCapabilities,
    });
    await expect.poll(() => sends).toBe(1);
    await events.push({ t: "turn.started", turnId: "native-turn" });
    const source = path.join(test.root, "src/a.ts");
    await events.push({
      t: "interaction.requested",
      interaction: {
        id: "native-approval",
        agentId: "profile",
        threadId: "thread",
        turnId: "native-turn",
        type: "approval",
        context: { toolName: "Write", toolKind: "edit", paths: [source] },
        items: [{ id: "operation", prompt: "Allow edit?", choices: [{ id: "allow_once" }] }],
        chain: [],
        urgency: "blocking",
      },
    });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]?.paths).toEqual([source]);
    const safe = received[0]?.event;
    if (safe?.t !== "interaction.requested") throw new Error("missing_safe_approval");
    expect(safe.interaction.context?.paths).toEqual(["[redacted]/src/a.ts"]);
    expect(JSON.stringify(safe)).not.toContain(test.root);
  } finally {
    await worker.close();
    test.close();
  }
});
