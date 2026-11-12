import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { AcpMapper, permissionInteraction, permissionOutcome } from "./mapping.js";

describe("ACP wire mapping", () => {
  it("preserves authoritative final text and separates thought and tool identities", () => {
    const mapper = new AcpMapper("turn-1");
    const events = [
      ...mapper.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one" },
      }),
      ...mapper.update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "think" },
      }),
      ...mapper.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "two" },
      }),
      ...mapper.update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Run",
        kind: "execute",
        rawInput: { command: "pwd" },
      }),
      ...mapper.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "done",
      }),
      ...mapper.finish("end_turn"),
    ];
    for (const event of events) expect(parse(AgentEventSchema, event)).toEqual(event);
    expect(events.find((e) => e.t === "message.done")).toMatchObject({
      text: "onetwo",
      phase: "final",
    });
    expect(events.find((e) => e.t === "thought.done")).toMatchObject({ text: "think" });
    expect(events.at(-1)).toMatchObject({ t: "turn.done", status: "completed" });
    expect(events.find((e) => e.t === "tool.started")).toMatchObject({
      itemId: "tool-1",
      kind: "execute",
    });
  });
  it("maps context, USD cost, plans, and cancellation without inventing token counts", () => {
    const mapper = new AcpMapper("turn-1");
    expect(
      mapper.update({
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        cost: { amount: 0.1, currency: "USD" },
      }),
    ).toEqual([
      {
        t: "usage.updated",
        turnId: "turn-1",
        usage: { contextUsed: 10, contextSize: 100, costUsd: 0.1, cumulative: true },
      },
    ]);
    const plan = mapper.update({
      sessionUpdate: "plan",
      entries: [{ content: "Build", priority: "high", status: "in_progress" }],
    });
    expect(parse(AgentEventSchema, plan[0])).toMatchObject({
      t: "plan.updated",
      entries: [{ step: "Build", status: "in_progress" }],
    });
    expect(mapper.finish("cancelled").at(-1)).toMatchObject({ status: "interrupted" });
  });
  it("retains opaque permission option ids and rejects fabricated or mismatched choices", () => {
    const request = {
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "Read" },
      options: [
        { optionId: "opaque-42", name: "Allow", kind: "allow_once" as const },
        { optionId: "opaque-99", name: "Deny", kind: "reject_once" as const },
      ],
    };
    const draft = permissionInteraction(request, {
      id: "i",
      agentId: "a",
      threadId: "th",
      turnId: "turn",
    });
    expect(draft.items[0]?.options?.map((x) => x.id)).toEqual(["opaque-42", "opaque-99"]);
    expect(permissionOutcome(request, "accept", "opaque-42")).toEqual({
      outcome: "selected",
      optionId: "opaque-42",
    });
    expect(permissionOutcome(request, "decline", "opaque-42")).toEqual({ outcome: "cancelled" });
    expect(permissionOutcome(request, "accept", "invented")).toEqual({ outcome: "cancelled" });
    expect(
      parse(AgentEventSchema, { t: "interaction.requested", interaction: draft }),
    ).toBeDefined();
  });
  it("retains edit diffs across partial updates and distinguishes a denied tool", () => {
    const mapper = new AcpMapper("turn-1");
    mapper.update({
      sessionUpdate: "tool_call",
      toolCallId: "edit",
      title: "Edit",
      kind: "edit",
      content: [{ type: "diff", path: "/work/repo/file.ts", oldText: "before", newText: "after" }],
    });
    expect(
      mapper.update({ sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" }),
    ).toEqual([
      {
        t: "tool.done",
        itemId: "edit",
        status: "ok",
        diffs: [{ path: "/work/repo/file.ts", before: "before", after: "after" }],
      },
    ]);
    mapper.rejectTool("exec");
    expect(
      mapper.update({ sessionUpdate: "tool_call_update", toolCallId: "exec", status: "failed" }),
    ).toEqual([{ t: "tool.done", itemId: "exec", status: "denied" }]);
  });
  it("maps compaction lifecycles without treating unknown states as completion", () => {
    const mapper = new AcpMapper("turn", "manual");
    expect(
      mapper.update({
        sessionUpdate: "compaction_update",
        compactionId: "c",
        status: "in_progress",
      }),
    ).toEqual([{ t: "compaction", state: "started", trigger: "manual" }]);
    expect(
      mapper.update({ sessionUpdate: "compaction_update", compactionId: "c", status: "failed" }),
    ).toEqual([
      { t: "compaction", state: "done", trigger: "manual" },
      { t: "status", state: "error", detail: "compaction_failed" },
    ]);
    expect(
      mapper.update({ sessionUpdate: "compaction_update", compactionId: "c", status: "future" }),
    ).toEqual([]);
  });
});

it("preserves native permission kinds and all file locations for workspace verification", () => {
  const request = permissionInteraction(
    {
      sessionId: "native",
      toolCall: {
        toolCallId: "edit",
        title: "Edit file",
        kind: "edit",
        locations: [{ path: "/work/a.ts" }, { path: "/work/b.ts" }],
      },
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    },
    { id: "request", agentId: "profile", threadId: "thread", turnId: "turn" },
  );
  expect(request.context).toMatchObject({ toolKind: "edit", paths: ["/work/a.ts", "/work/b.ts"] });
});

it("offers durable normalized approval choices and maps them back to opaque native ids", () => {
  const request = {
    sessionId: "native",
    toolCall: { toolCallId: "edit", title: "Edit" },
    options: [
      { optionId: "provider-once", name: "Allow", kind: "allow_once" as const },
      { optionId: "provider-forever", name: "Always", kind: "allow_always" as const },
      { optionId: "provider-deny", name: "Deny", kind: "reject_once" as const },
    ],
  };
  const draft = permissionInteraction(request, {
    id: "request",
    agentId: "profile",
    threadId: "thread",
    turnId: "turn",
  });
  expect(draft.items[0]?.choices).toEqual([{ id: "allow_once" }, { id: "reject_once" }]);
  expect(permissionOutcome(request, "accept", "allow_once")).toEqual({
    outcome: "selected",
    optionId: "provider-once",
  });
  expect(permissionOutcome(request, "decline")).toEqual({
    outcome: "selected",
    optionId: "provider-deny",
  });
  expect(permissionOutcome(request, "accept", "allow_session")).toEqual({ outcome: "cancelled" });
});

it("resolves normalized one-time choices by native kind even when an indefinite option reuses that id", () => {
  expect(
    permissionOutcome(
      {
        sessionId: "s",
        toolCall: { toolCallId: "tool" },
        options: [
          { optionId: "allow_once", name: "Always", kind: "allow_always" },
          { optionId: "opaque-once", name: "Once", kind: "allow_once" },
        ],
      },
      "accept",
      "allow_once",
    ),
  ).toEqual({ outcome: "selected", optionId: "opaque-once" });
});

it("separates ACP commentary from the answer when providers omit message ids", () => {
  const mapper = new AcpMapper("turn");
  const chunk = (text: string) =>
    mapper.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const before = chunk("I'll check.");
  mapper.update({
    sessionUpdate: "tool_call",
    toolCallId: "search",
    title: "Search",
    kind: "search",
  });
  const after = chunk("The answer ");
  const continuation = chunk("is here.");
  expect(before[0]).toMatchObject({ itemId: "turn:message:default" });
  expect(after[0]).toMatchObject({ itemId: "turn:message:default:1" });
  expect(continuation[0]).toMatchObject({ itemId: "turn:message:default:1" });
  const events = mapper.finish("end_turn");
  expect(events.filter((event) => event.t === "message.done")).toMatchObject([
    { itemId: "turn:message:default", text: "I'll check.", phase: "commentary" },
    { itemId: "turn:message:default:1", text: "The answer is here.", phase: "final" },
  ]);
  for (const event of events) expect(parse(AgentEventSchema, event)).toEqual(event);
});

it("preserves explicit ACP message identities around tool calls", () => {
  const mapper = new AcpMapper("turn");
  const update = {
    sessionUpdate: "agent_message_chunk" as const,
    messageId: "provider-message",
    content: { type: "text" as const, text: "Hello" },
  };
  const first = mapper.update(update);
  mapper.update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read" });
  expect(mapper.update(update)[0]).toMatchObject({
    itemId: first[0]?.t === "text.delta" ? first[0].itemId : "missing",
  });
});
