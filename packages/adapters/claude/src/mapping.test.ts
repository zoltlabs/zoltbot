import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { ClaudeMapper } from "./mapping.js";

it("uses full assistant text as the authoritative final message", () => {
  const mapper = new ClaudeMapper("turn");
  const events = [
    ...mapper.frame({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message" } },
    }),
    ...mapper.frame({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
    }),
    ...mapper.frame({
      type: "assistant",
      message: { id: "message", content: [{ type: "text", text: "authoritative" }] },
    }),
    ...mapper.frame({
      type: "result",
      subtype: "success",
      result: "authoritative",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 8 },
    }),
  ];
  expect(events.find((e) => e.t === "text.delta")).toMatchObject({ text: "partial" });
  expect(events.find((e) => e.t === "message.done")).toMatchObject({
    text: "authoritative",
    phase: "final",
  });
  expect(events.filter((e) => e.t === "message.done")).toHaveLength(1);
  for (const event of events) expect(parse(AgentEventSchema, event)).toBeDefined();
});
it("keeps nested activity linked to its parent and out of the root final answer", () => {
  const mapper = new ClaudeMapper("turn");
  const events = [
    ...mapper.frame({
      type: "assistant",
      parent_tool_use_id: "parent",
      message: {
        id: "child-message",
        content: [
          { type: "text", text: "child" },
          { type: "tool_use", id: "child-tool", name: "Read", input: { file_path: "safe.txt" } },
        ],
      },
    }),
    ...mapper.frame({
      type: "assistant",
      message: { id: "root", content: [{ type: "text", text: "root final" }] },
    }),
    ...mapper.frame({ type: "result", subtype: "success", result: "root final" }),
  ];
  expect(events.find((e) => e.t === "tool.started")).toMatchObject({
    itemId: "child-tool",
    parentItemId: "parent",
  });
  expect(events.find((e) => e.t === "message.done" && e.text === "child")).toMatchObject({
    parentItemId: "parent",
    phase: "commentary",
  });
  expect(events.filter((e) => e.t === "message.done" && e.phase === "final")).toHaveLength(1);
  for (const event of events) expect(parse(AgentEventSchema, event)).toBeDefined();
});
it("distinguishes denied tool results and rejects malformed text deltas", () => {
  const mapper = new ClaudeMapper("turn");
  mapper.denyTool("tool");
  expect(
    mapper.frame({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool", content: "denied", is_error: true }],
      },
    }),
  ).toEqual([{ t: "tool.done", itemId: "tool", status: "denied", output: "denied" }]);
  expect(() =>
    mapper.frame({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: 3 } },
    }),
  ).toThrow("provider_protocol_error");
});

it("preserves edit diffs and final tool output", () => {
  const mapper = new ClaudeMapper("turn");
  mapper.frame({
    type: "assistant",
    message: {
      id: "m",
      content: [
        {
          type: "tool_use",
          id: "edit",
          name: "Edit",
          input: { file_path: "safe.txt", old_string: "before", new_string: "after" },
        },
      ],
    },
  });
  const events = mapper.frame({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "updated" }] },
  });
  expect(events.find((e) => e.t === "tool.updated")).toMatchObject({ output: "updated" });
  expect(events.find((e) => e.t === "tool.done")).toMatchObject({
    status: "ok",
    diffs: [{ path: "safe.txt", before: "before", after: "after" }],
  });
});
