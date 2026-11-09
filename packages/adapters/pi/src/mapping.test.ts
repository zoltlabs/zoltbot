import { readFileSync } from "node:fs";
import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { PiMapper } from "./mapping.js";

it("keeps a user turn open past agent_end and chooses the last assistant answer", () => {
  const mapper = new PiMapper("turn");
  expect(
    mapper.frame({
      type: "message_end",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "working" }] },
    }),
  ).toEqual([]);
  expect(
    mapper.frame({
      type: "message_end",
      message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "done" }] },
    }),
  ).toEqual([expect.objectContaining({ phase: "commentary", text: "working" })]);
  expect(mapper.frame({ type: "agent_end" })).toEqual([]);
  expect(mapper.frame({ type: "agent_settled", aborted: false })).toEqual([
    expect.objectContaining({ phase: "final", text: "done" }),
    { t: "turn.done", turnId: "turn", status: "completed" },
  ]);
  expect(mapper.frame({ type: "agent_settled", aborted: false })).toEqual([]);
});
it("preserves nested tools and distinguishes bundled gate denials", () => {
  const mapper = new PiMapper("turn");
  expect(
    mapper.frame({
      type: "tool_execution_start",
      toolCallId: "tool",
      toolName: "bash",
      parentToolCallId: "parent",
      args: {},
    }),
  ).toEqual([expect.objectContaining({ t: "tool.started", parentItemId: "parent" })]);
  expect(
    mapper.frame({
      type: "tool_execution_end",
      toolCallId: "tool",
      parentToolCallId: "parent",
      isError: true,
      result: { content: [{ type: "text", text: "ZOLTBOT_DENIED:Request declined" }] },
    }),
  ).toEqual([
    expect.objectContaining({ t: "tool.done", status: "denied", parentItemId: "parent" }),
  ]);
});
it("includes cache reads and writes in normalized input totals and rejects invalid deltas", () => {
  const mapper = new PiMapper("turn");
  expect(
    mapper.frame({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1,
        content: [],
        usage: { input: 2, output: 3, cacheRead: 10, cacheWrite: 4, cost: { total: 0.01 } },
      },
    }),
  ).toEqual([
    expect.objectContaining({
      t: "usage.updated",
      usage: expect.objectContaining({
        inputTokens: 16,
        outputTokens: 3,
        costUsd: 0.01,
        cumulative: false,
      }),
    }),
  ]);
  expect(() =>
    mapper.frame({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: 42 },
    }),
  ).toThrow("provider_protocol_error");
});

it("replays real Pi turns and accumulates usage across the assistant tool loop", () => {
  const records = readFileSync("fixtures/pi/1.4.0/permission-local-provider.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  let mapper = new PiMapper("turn-1");
  let completed = 0;
  const trace = records
    .filter((r) => r.direction === "stdout")
    .flatMap((r) => {
      const events = mapper.frame(r.message);
      if (r.message.type === "agent_settled") mapper = new PiMapper(`turn-${++completed + 1}`);
      return events;
    });
  expect(trace.filter((e) => e.t === "message.done" && e.phase === "final")).toHaveLength(2);
  const samples = trace.filter((e) => e.t === "usage.updated");
  expect(samples.at(1)).toMatchObject({
    usage: { inputTokens: 20, outputTokens: 4, cumulative: false },
  });
});

it("emits schema valid compaction boundaries and reports aborted compaction honestly", () => {
  const mapper = new PiMapper("turn");
  const started = mapper.frame({ type: "compaction_start" });
  const done = mapper.frame({ type: "compaction_end", result: { tokensBefore: 20 } });
  for (const event of [...started, ...done]) expect(parse(AgentEventSchema, event)).toEqual(event);
  expect(started).toEqual([{ t: "compaction", state: "started", trigger: "manual" }]);
  expect(mapper.frame({ type: "auto_compaction_end", aborted: true })).toEqual([
    { t: "status", state: "error", detail: "compaction_aborted_or_failed" },
  ]);
});
