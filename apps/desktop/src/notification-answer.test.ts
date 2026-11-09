import path from "node:path";
import { type Daemon, startDaemon } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { answerNotification } from "./notification-answer.js";

it("uses authenticated version fenced once answers and rejects a stale OS action", async () => {
  const test = await runtimeFixture();
  let daemon: Daemon | undefined,
    replies = 0;
  try {
    daemon = await startDaemon({
      dataDir: path.join(test.root, "daemon"),
      interactionHost: {
        registerSecret() {},
        requiresSecretReply() {
          return true;
        },
        async respond() {
          replies++;
        },
      },
    });
    for (const kind of ["agentDefinition", "agent", "thread"] as const)
      for (const value of test.store.snapshot()[kind] ?? [])
        daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
    const engine = daemon.interactions;
    if (!engine) throw new Error("fixture_engine_missing");
    engine.request(
      {
        id: "approval",
        agentId: "profile",
        threadId: "thread",
        type: "approval",
        items: [
          {
            id: "approve",
            prompt: "Allow harmless fixture operation?",
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
          },
        ],
        chain: [],
        urgency: "blocking",
      },
      "request",
    );
    const info = { url: daemon.url, token: daemon.token };
    await answerNotification(info, { id: "approval", version: 1 }, "allow_once");
    expect(replies).toBe(1);
    expect(daemon.store.snapshot().interaction?.[0]).toMatchObject({
      state: "answered",
      resolution: { choice: "allow_once", by: { kind: "human", id: "local-owner" } },
    });
    await expect(
      answerNotification(info, { id: "approval", version: 1 }, "reject_once"),
    ).rejects.toThrow("notification_action_failed");
    expect(replies).toBe(1);
  } finally {
    await daemon?.close();
    test.close();
  }
});
