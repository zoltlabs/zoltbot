import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { ClaudeBackground } from "./background.js";
import { ClaudeMapper } from "./mapping.js";

const at = "2026-11-05T00:00:00.000Z";
it("tracks task frames from start to notification and ignores malformed ones", () => {
  const background = new ClaudeBackground(() => at);
  const events = [
    ...background.system({
      type: "system",
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "tool-1",
      description: "Review",
      task_type: "local_agent",
      future: "ignored",
    }),
    ...background.system({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      summary: "Half",
    }),
    ...background.system({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "completed",
      output_file: "/tmp/a1.out",
      summary: "Done",
    }),
    ...background.system({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "odd",
    }),
    ...background.system({ type: "system", subtype: "task_started" }),
    ...background.system({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      summary: "late",
    }),
  ];
  expect(events.map((e) => (e.t === "background.updated" ? e.task.state : e.t))).toEqual([
    "running",
    "running",
    "completed",
  ]);
  expect(events[2]).toEqual({
    t: "background.updated",
    task: {
      id: "a1",
      kind: "agent",
      description: "Review",
      state: "completed",
      summary: "Done",
      outputPath: "/tmp/a1.out",
      toolItemId: "tool-1",
      startedAt: at,
      endedAt: at,
    },
  });
  for (const event of events) expect(parse(AgentEventSchema, event)).toBeDefined();
  expect(background.running()).toEqual([]);
});
it("detects backgrounded Bash results through the mapper and stops tasks when the process ends", () => {
  const background = new ClaudeBackground(() => at);
  const mapper = new ClaudeMapper("turn", background);
  mapper.frame({
    type: "assistant",
    message: {
      id: "m",
      content: [
        {
          type: "tool_use",
          id: "bash",
          name: "Bash",
          input: { command: "npm run dev", run_in_background: true },
        },
        { type: "tool_use", id: "plain", name: "Bash", input: { command: "echo" } },
      ],
    },
  });
  const events = mapper.frame({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "bash",
          content:
            "Command running in background with ID: b7. Output is being written to: /tmp/b7.output",
        },
        // Command output that merely looks like a notice is not a background task.
        {
          type: "tool_result",
          tool_use_id: "plain",
          content: "Command running in background with ID: fake.",
        },
      ],
    },
  });
  const updates = events.filter((e) => e.t === "background.updated");
  expect(updates).toEqual([
    {
      t: "background.updated",
      task: {
        id: "b7",
        kind: "shell",
        description: "npm run dev",
        state: "running",
        outputPath: "/tmp/b7.output",
        toolItemId: "bash",
        startedAt: at,
      },
    },
  ]);
  expect(background.ended()).toMatchObject([
    { t: "background.updated", task: { id: "b7", state: "stopped", endedAt: at } },
  ]);
  expect(background.ended()).toEqual([]);
});
it("prefers the structured background id from tool_use_result", () => {
  const background = new ClaudeBackground(() => at);
  const mapper = new ClaudeMapper("turn", background);
  mapper.frame({
    type: "assistant",
    message: {
      id: "m",
      content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "sleep 99" } }],
    },
  });
  const events = mapper.frame({
    type: "user",
    tool_use_result: { backgroundTaskId: "manual-1", backgroundedByUser: true },
    message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "" }] },
  });
  expect(events.find((e) => e.t === "background.updated")).toMatchObject({
    task: { id: "manual-1", kind: "shell", description: "sleep 99" },
  });
});
