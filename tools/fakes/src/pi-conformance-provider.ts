// Synthetic Pi 1.4.0 RPC provider. Real runtime evidence is kept in separate recordings.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { recordAttachments } from "./attachment-receipt.js";
import { callFixtureHost } from "./host-mcp-call.js";

const args = process.argv.slice(2);
const flag = (key: string) => args[args.indexOf(key) + 1];
const config = JSON.parse(readFileSync(process.env.ZOLTBOT_PI_CONFIG ?? "", "utf8"));
const nativeId = args.includes("--session-id") ? flag("--session-id") : flag("--session");
const nativeFile = path.join(process.cwd(), "pi-native.json");
const native = existsSync(nativeFile) ? JSON.parse(readFileSync(nativeFile, "utf8")) : {};
native[nativeId ?? "native"] ??= {};
writeFileSync(nativeFile, JSON.stringify(native), { mode: 0o600 });
writeFileSync(
  path.join(process.cwd(), "environment-keys.json"),
  JSON.stringify(Object.fromEntries(Object.keys(process.env).map((key) => [key, "present"]))),
  { mode: 0o600 },
);
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (request: { id: string; type: string }, data: unknown) =>
  out({ type: "response", id: request.id, command: request.type, success: true, data });
let turn = 0,
  count = 0;
let busy = false,
  hung = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: string | undefined;
let questionTitle = "";
let selectedQuestion = "";
function finish(aborted = false) {
  out({
    type: "message_end",
    message: {
      role: "assistant",
      timestamp: turn,
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      usage: {
        input: 2,
        output: 2,
        cacheRead: 8,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { total: 0.001 },
      },
    },
  });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled", aborted });
  busy = false;
  pending = undefined;
}
function tool(id: string, name: string, input: unknown) {
  out({ type: "tool_execution_start", toolCallId: id, toolName: name, args: input });
}
function result(id: string, text: string, isError = false) {
  out({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "bash",
    result: { content: [{ type: "text", text }] },
    isError,
  });
}
async function run(text: string) {
  busy = true;
  turn++;
  count++;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "assistant", timestamp: turn, content: [] } });
  out({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
  });
  if (text === "slow") {
    timer = setTimeout(() => finish(), 500);
    return;
  }
  if (text === "hang") {
    hung = true;
    return;
  }
  if (["approval", "crash"].includes(text)) {
    tool("approval-tool", "bash", { command: "echo synthetic" });
    pending = "approval";
    out({
      type: "extension_ui_request",
      id: "approval-ui",
      method: "confirm",
      title: "Zoltbot approval",
      message: JSON.stringify({
        itemId: "approval-tool",
        toolName: "bash",
        input: { command: "echo synthetic" },
        cwd: process.cwd(),
      }),
    });
    if (text === "crash") setTimeout(() => process.exit(1), 30);
    return;
  }
  if (["question", "duplicate_questions"].includes(text)) {
    tool("question-tool", "zoltbot_ask_human", {});
    questionTitle = text === "duplicate_questions" ? "Same question" : "Choose option";
    pending = "select";
    out({
      type: "extension_ui_request",
      id: "select-ui",
      method: "select",
      title: questionTitle,
      options: ["First", "Second"],
    });
    return;
  }
  if (text === "tools") {
    tool("edit-tool", "edit", { path: "a.txt", oldText: "before", newText: "after" });
    result("edit-tool", "edited");
    tool("execute-tool", "bash", { command: "echo synthetic" });
    out({
      type: "tool_execution_update",
      toolCallId: "execute-tool",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    result("execute-tool", "output");
    tool("error-tool", "bash", { command: "false" });
    result("error-tool", "error", true);
  }
  if (text === "unknown") out({ type: "future_event", value: true });
  if (text === "malformed") {
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 42 } });
    return;
  }
  if (text === "host_tools") {
    tool("host-tool", "mcp__zoltbot__team_status", {});
    const response = await callFixtureHost(config.hostMcp.url, {
      Authorization: `Bearer ${config.hostMcp.token}`,
    });
    result("host-tool", response, false);
  }
  if (text === "secret_frames") out({ type: "future_event", token: "seeded-secret" });
  finish();
}
process.stderr.write("ZOLTBOT_FAKE_READY\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (hung) continue;
  if (request.type === "extension_ui_response") {
    if (pending === "select" || pending === "input") {
      if (request.id !== `${pending}-ui`) throw new Error("unexpected_question_reply");
      if (request.cancelled === true) {
        result("question-tool", "cancelled");
        finish();
        continue;
      }
      if (typeof request.value !== "string" || !request.value.trim())
        throw new Error("invalid_native_question_reply");
      if (pending === "select") {
        if (!["First", "Second"].includes(request.value))
          throw new Error("invalid_native_selection");
        selectedQuestion = request.value;
        pending = "input";
        out({
          type: "extension_ui_request",
          id: "input-ui",
          method: "input",
          title: questionTitle === "Same question" ? questionTitle : "Provide text",
          placeholder: "Enter text",
        });
      } else {
        result(
          "question-tool",
          JSON.stringify({ selected: selectedQuestion, text: request.value }),
        );
        finish();
      }
      continue;
    }
    if (pending !== "approval" || request.id !== "approval-ui")
      throw new Error("unexpected_ui_reply");
    const allow = request.confirmed === true;
    result("approval-tool", allow ? "allowed" : "ZOLTBOT_DENIED:Request declined", !allow);
    finish();
    continue;
  }
  switch (request.type) {
    case "get_state":
      reply(request, {
        sessionId: nativeId,
        isStreaming: busy,
        isCompacting: false,
        thinkingLevel: "medium",
        model: { id: "model", provider: "test", contextWindow: 100 },
      });
      break;
    case "get_commands":
      reply(request, {
        commands: [
          { name: "fixture", description: "Native fixture command" },
          { name: "zoltbot_ready", source: "extension", sourceInfo: { path: flag("--extension") } },
        ],
      });
      break;
    case "get_available_models":
      reply(request, {
        models: [{ id: "model", name: "Model", provider: "test", contextWindow: 100 }],
      });
      break;
    case "get_session_stats":
      reply(request, {
        tokens: {
          input: count * 2,
          output: count * 2,
          cacheRead: count * 8,
          cacheWrite: 0,
          total: count * 12,
        },
        cost: count * 0.001,
        contextUsage: { tokens: 20, contextWindow: 100 },
      });
      break;
    case "set_session_name":
      native[nativeId ?? "native"].name = request.name;
      writeFileSync(nativeFile, JSON.stringify(native), { mode: 0o600 });
      reply(request, {});
      break;
    case "set_model":
    case "set_thinking_level":
      reply(request, {});
      break;
    case "steer":
      reply(request, {});
      out({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "steered" },
      });
      break;
    case "abort":
      clearTimeout(timer);
      reply(request, {});
      if (busy) finish(true);
      break;
    case "compact":
      reply(request, { summary: "compacted", tokensBefore: 20 });
      out({ type: "compaction_end", result: { tokensBefore: 20 }, aborted: false });
      break;
    case "prompt":
      recordAttachments([request.message], request.images ?? []);
      if (request.message === "/zoltbot_ready") {
        out({
          type: "extension_ui_request",
          id: "ready",
          method: "notify",
          message: `zoltbot_ready:${config.nonce}`,
          notifyType: "info",
        });
        reply(request, { disposition: "handled" });
        break;
      }
      if (busy) {
        reply(request, { disposition: "queued" });
        break;
      }
      reply(request, { disposition: "started" });
      void run(request.message);
      break;
    default:
      out({
        type: "response",
        id: request.id,
        command: request.type,
        success: false,
        error: "unsupported_command",
      });
  }
}
