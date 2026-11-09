import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { ClaudeMapper } from "./mapping.js";

it("marks interactive tools and titles timeline tools without dropping their lifecycle", () => {
  const mapper = new ClaudeMapper("turn");
  const started = mapper.frame({
    type: "assistant",
    message: {
      id: "m",
      content: [
        { type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [] } },
        { type: "tool_use", id: "plan", name: "ExitPlanMode", input: { plan: "# P" } },
        { type: "tool_use", id: "read", name: "Read", input: { file_path: "/w/a.ts", offset: 3 } },
        {
          type: "tool_use",
          id: "multi",
          name: "MultiEdit",
          input: {
            file_path: "/w/a.ts",
            edits: [
              { old_string: "a", new_string: "b" },
              { old_string: "c", new_string: "d" },
            ],
          },
        },
        { type: "tool_use", id: "task", name: "Task", input: { description: "Review" } },
      ],
    },
  });
  const tools = started.filter((e) => e.t === "tool.started");
  expect(tools.map((e) => (e.t === "tool.started" ? e.interactive : undefined))).toEqual([
    true,
    true,
    undefined,
    undefined,
    undefined,
  ]);
  expect(tools[2]).toMatchObject({
    kind: "read",
    title: "/w/a.ts",
    locations: [{ path: "/w/a.ts", line: 3 }],
  });
  expect(tools[3]).toMatchObject({ kind: "edit", title: "/w/a.ts" });
  expect(tools[4]).toMatchObject({ kind: "agent", title: "Review" });
  const done = mapper.frame({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "ask", content: "answered" },
        { type: "tool_result", tool_use_id: "multi", content: "ok" },
        { type: "tool_result", tool_use_id: "task", content: [{ type: "text", text: "found" }] },
      ],
    },
  });
  expect(done.flatMap((e) => (e.t === "tool.done" ? [e.itemId] : []))).toEqual([
    "ask",
    "multi",
    "task",
  ]);
  expect(done.find((e) => e.t === "tool.done" && e.itemId === "multi")).toMatchObject({
    diffs: [
      { path: "/w/a.ts", before: "a", after: "b" },
      { path: "/w/a.ts", before: "c", after: "d" },
    ],
  });
  expect(done.find((e) => e.t === "tool.done" && e.itemId === "task")).toMatchObject({
    output: "found",
  });
  for (const event of [...started, ...done]) expect(parse(AgentEventSchema, event)).toBeDefined();
});
it("keeps subagent tool results linked to the parent and records the replayed input uuid", () => {
  const mapper = new ClaudeMapper("turn");
  mapper.frame({ type: "user", uuid: "native-uuid", message: { content: "do it" } });
  mapper.frame({
    type: "user",
    uuid: "later",
    message: { content: [{ type: "text", text: "x" }] },
  });
  expect(mapper.userUuid).toBe("native-uuid");
  mapper.frame({
    type: "assistant",
    parent_tool_use_id: "task",
    message: {
      id: "child",
      content: [{ type: "tool_use", id: "child-bash", name: "Bash", input: { command: "ls" } }],
    },
  });
  const events = mapper.frame({
    type: "user",
    uuid: "tool-result-uuid",
    message: { content: [{ type: "tool_result", tool_use_id: "child-bash", content: "a.ts" }] },
  });
  expect(events).toEqual([
    { t: "tool.updated", itemId: "child-bash", parentItemId: "task", output: "a.ts" },
    { t: "tool.done", itemId: "child-bash", parentItemId: "task", status: "ok", output: "a.ts" },
  ]);
  expect(mapper.userUuid).toBe("native-uuid");
});
