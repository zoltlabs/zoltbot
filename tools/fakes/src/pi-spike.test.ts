import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const records = readFileSync("fixtures/pi/1.4.0/rpc-no-auth.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const responses = (command: string) =>
  records
    .filter(
      (r) =>
        r.direction === "stdout" && r.message.type === "response" && r.message.command === command,
    )
    .map((r) => r.message);
it("records prompt free native state, session naming, and an empty credential scoped model catalog", () => {
  expect(responses("get_state")).toHaveLength(2);
  expect(responses("get_state")[1].data.sessionName).toBe("Zoltbot isolated spike");
  expect(responses("get_available_models")[0].data.models).toEqual([]);
  expect(
    records.some(
      (r) =>
        r.message.type === "session_info_changed" && r.message.name === "Zoltbot isolated spike",
    ),
  ).toBe(true);
});
it("correlates a real extension confirmation and preserves its decline", () => {
  const dialog = records.find(
    (r) =>
      r.direction === "stdout" &&
      r.message.type === "extension_ui_request" &&
      r.message.method === "confirm",
  ).message;
  const reply = records.find(
    (r) => r.direction === "stdin" && r.message.type === "extension_ui_response",
  ).message;
  expect(reply).toEqual({ type: "extension_ui_response", id: dialog.id, confirmed: false });
  expect(
    records.some(
      (r) => r.message.type === "extension_ui_request" && r.message.message === "spike_denied",
    ),
  ).toBe(true);
});
it("handles extension commands without model turns, tokens, or cost", () => {
  expect(responses("prompt")).toHaveLength(2);
  for (const reply of responses("prompt")) expect(reply.data.disposition).toBe("handled");
  for (const reply of responses("get_session_stats"))
    expect(reply.data).toMatchObject({
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      cost: 0,
      tokens: { total: 0 },
    });
  expect(
    records.some((r) => ["agent_start", "agent_end", "agent_settled"].includes(r.message.type)),
  ).toBe(false);
});
it("discovers the native MCP tool through an authenticated per session registration", () => {
  const traffic = JSON.parse(readFileSync("fixtures/pi/1.4.0/mcp-http-no-auth.json", "utf8"));
  expect(traffic.map((r: { method: string }) => r.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  expect(traffic.every((r: { authorized: boolean }) => r.authorized)).toBe(true);
  const listing = records.find(
    (r) =>
      r.message.type === "extension_ui_request" &&
      r.message.method === "notify" &&
      r.message.message.startsWith("["),
  );
  expect(JSON.parse(listing.message.message)).toContain("mcp__zoltbot__spike_ping");
});
it("blocks real Pi tool execution on a decline and on an unanswered dialog", () => {
  const messages = readFileSync("fixtures/pi/1.4.0/permission-local-provider.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).message);
  const dialogs = messages.filter(
    (m) => m.type === "extension_ui_request" && m.method === "confirm",
  );
  expect(dialogs).toHaveLength(2);
  expect(messages.filter((m) => m.type === "extension_ui_response")).toEqual([
    { type: "extension_ui_response", id: dialogs[0].id, confirmed: false },
  ]);
  const results = messages.filter((m) => m.type === "tool_execution_end");
  expect(results).toHaveLength(2);
  for (const result of results)
    expect(result).toMatchObject({
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "Zoltbot gate denied" }] },
    });
  expect(messages.filter((m) => m.type === "agent_settled")).toHaveLength(2);
  expect(
    messages.some(
      (m) =>
        m.type === "message_end" &&
        m.message.role === "assistant" &&
        m.message.content.some((b: { text?: string }) => b.text === "Local fixture complete."),
    ),
  ).toBe(true);
});
