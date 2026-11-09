import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const records = readFileSync("fixtures/claude/2.1.299/initialize-mcp-no-auth.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
function response(id: string) {
  return records.find((r) => r.direction === "stdout" && r.message.response?.request_id === id)
    ?.message.response;
}
it("records explicit permission mode and connected HTTP MCP before any user input", () => {
  expect(records.some((r) => r.direction === "stdin" && r.message.type === "user")).toBe(false);
  expect(response("initialize-1").response.current_permission_mode).toBe("default");
  expect(response("mcp-status-1").response.mcpServers).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "zoltbot", status: "connected" })]),
  );
  expect(records.some((r) => r.message.type === "system" && r.message.subtype === "init")).toBe(
    false,
  );
});
it("records context summary fields and native host tool names without a model turn", () => {
  const context = response("context-1").response;
  expect(context.totalTokens).toBeGreaterThan(0);
  expect(context.maxTokens).toBeGreaterThan(context.totalTokens);
  expect(context.mcpTools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "mcp__zoltbot__spike_ping", isLoaded: false }),
    ]),
  );
  expect(context.memoryFiles).toHaveLength(0);
});
it("records matching control ids for idle interrupt and unknown subtype errors", () => {
  expect(response("interrupt-1").subtype).toBe("success");
  expect(response("unknown-1").subtype).toBe("error");
  expect(typeof response("unknown-1").error).toBe("string");
  const requests = records.filter((r) => r.direction === "stdin").map((r) => r.message.request_id);
  const responses = records
    .filter((r) => r.direction === "stdout")
    .map((r) => r.message.response.request_id);
  expect(new Set(responses)).toEqual(new Set(requests));
});
