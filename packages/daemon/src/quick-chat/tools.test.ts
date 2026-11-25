import type { AgentSession } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, test, vi } from "vitest";
import { toolInference } from "./tools.js";

/** A session that answers every message with one line of text. */
function fakeSession(reply: string) {
  const waiting: ((event: unknown) => void)[] = [];
  const queued: unknown[] = [];
  let closed = false;
  const push = (event: unknown) => {
    const next = waiting.shift();
    if (next) next(event);
    else queued.push(event);
  };
  const session = {
    capabilities: { models: { list: [] } },
    nativeId: undefined,
    async *events() {
      while (!closed) {
        const event = queued.length
          ? queued.shift()
          : await new Promise((resolve) => waiting.push(resolve));
        if (event === "closed") return;
        yield event;
      }
    },
    async send() {
      queueMicrotask(() => {
        push({ t: "turn.started" });
        push({ t: "text.delta", text: reply });
        push({ t: "turn.done", status: "completed" });
      });
      return {};
    },
    async interrupt() {},
    async close() {
      closed = true;
      push("closed");
    },
  };
  return session as unknown as AgentSession;
}

test("routing uses a session opened ahead of time", async () => {
  const open = vi.fn(async () => fakeSession('{"intent":"chat"}'));
  const inference = toolInference({
    runtime: { open, close: async () => {} },
    definition: () => ({ id: "claude" }) as unknown as AgentDefinition,
  });
  const route = (conversationId: string) =>
    inference.adapter("claude").stream({
      model: "haiku",
      instructions: "Classify.",
      conversationId,
      turns: [{ role: "user", text: "Build a feature" }],
      signal: new AbortController().signal,
      onText: () => {},
    });
  const opened = () =>
    open.mock.calls.map((call) => (call as unknown[])[1] as { conversationId: string });
  await route("router-first");
  // The first call opened its own session and a spare for the next call.
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(opened().map((options) => options.conversationId)).toContain("router-first");
  await route("router-second");
  // The second call took the spare instead of opening a session of its own.
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3));
  expect(opened().map((options) => options.conversationId)).not.toContain("router-second");
  await inference.close();
});
