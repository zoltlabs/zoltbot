import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { codexNotification } from "./mapping.js";

it("uses authoritative item text and maps final_answer to final", () => {
  const events = codexNotification("item/completed", {
    threadId: "th",
    turnId: "t",
    completedAtMs: 0,
    item: { id: "m", type: "agentMessage", text: "complete", phase: "final_answer" },
  });
  expect(events).toEqual([
    { t: "message.done", turnId: "t", itemId: "m", text: "complete", phase: "final" },
  ]);
  expect(parse(AgentEventSchema, events[0])).toBeDefined();
});
it("keeps commentary distinct and maps interruption as terminal", () => {
  expect(
    codexNotification("item/completed", {
      turnId: "t",
      item: { id: "m", type: "agentMessage", text: "working", phase: "commentary" },
    })[0],
  ).toMatchObject({ phase: "commentary" });
  expect(
    codexNotification("turn/completed", { turn: { id: "t", status: "interrupted", items: [] } }),
  ).toEqual([{ t: "turn.done", turnId: "t", status: "interrupted" }]);
});
it("emits per turn and cumulative token samples with cache reads", () => {
  const last = {
    cachedInputTokens: 8,
    inputTokens: 10,
    outputTokens: 2,
    reasoningOutputTokens: 1,
    totalTokens: 12,
  };
  const total = {
    cachedInputTokens: 24,
    inputTokens: 30,
    outputTokens: 6,
    reasoningOutputTokens: 3,
    totalTokens: 36,
  };
  const events = codexNotification("thread/tokenUsage/updated", {
    turnId: "t",
    tokenUsage: { last, total, modelContextWindow: 100 },
  });
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    t: "usage.updated",
    turnId: "t",
    usage: {
      inputTokens: 10,
      cacheReadTokens: 8,
      cumulative: false,
      contextUsed: 12,
      contextSize: 100,
    },
  });
  expect(events[1]).toMatchObject({
    usage: { inputTokens: 30, cacheReadTokens: 24, cumulative: true },
  });
  for (const event of events) expect(parse(AgentEventSchema, event)).toBeDefined();
});
it("ignores unknown notifications", () => {
  expect(codexNotification("future/method", {})).toEqual([]);
});
it("maps web search items to a visible search tool", () => {
  const item = { id: "w", type: "webSearch", query: "release checklist", results: [{ url: "u" }] };
  const started = codexNotification("item/started", { turnId: "t", item });
  expect(started).toEqual([
    {
      t: "tool.started",
      turnId: "t",
      itemId: "w",
      name: "webSearch",
      kind: "search",
      input: { query: "release checklist" },
      title: "release checklist",
    },
  ]);
  const completed = codexNotification("item/completed", { turnId: "t", item });
  expect(completed.map((event) => event.t)).toEqual(["tool.started", "tool.done"]);
  for (const event of [...started, ...completed])
    expect(parse(AgentEventSchema, event)).toBeDefined();
});

it("treats a completed command with a nonzero exit code as failed", () => {
  const result = codexNotification("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: {
      id: "test-command",
      type: "commandExecution",
      status: "completed",
      command: "node --test",
      exitCode: 1,
      aggregatedOutput: "1 test failed",
    },
  });
  expect(result).toContainEqual(expect.objectContaining({ t: "tool.done", status: "error" }));
});
