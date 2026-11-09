// Stateful ACP v1 wire fake. Test scenarios never emit normalized AgentEvents.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { recordAttachments } from "./attachment-receipt.js";
import { artifactFixturePrompt, callFixtureHost, workspaceRequests } from "./host-mcp-call.js";

const out = (value: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(value as object) })}\n`);
const reply = (id: unknown, result: unknown) => out({ id, result });
const sessionId = process.env.ACP_TEST_UNIQUE_IDS
  ? `fake-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}`
  : "fake-session";
const update = (update: unknown) =>
  out({ method: "session/update", params: { sessionId, update } });
let promptId: unknown;
let pending: string | undefined;
let pendingKind = "permission";
const flavor = process.env.ACP_TEST_FLAVOR;
let timer: ReturnType<typeof setTimeout> | undefined;
let host: { url: string; headers: { name: string; value: string }[] } | undefined;
const native = path.join(process.cwd(), "fake-acp-native.json");
writeFileSync(
  path.join(process.cwd(), "environment-keys.json"),
  JSON.stringify(Object.fromEntries(Object.keys(process.env).map((k) => [k, "present"]))),
  { mode: 0o600 },
);
function finish(stopReason = "end_turn") {
  if (stopReason !== "cancelled")
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
  reply(promptId, { stopReason });
  promptId = undefined;
}
async function prompt(text: string) {
  if (text === "commands_update")
    update({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "updated", description: "Updated native command" }],
    });
  if (text === "hang") return;
  if (text === "form") {
    pending = "elicitation-request";
    pendingKind = "form";
    out({
      id: pending,
      method: "elicitation/create",
      params: {
        mode: "form",
        sessionId,
        message: "Configure the task",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", minLength: 2 } },
          required: ["name"],
        },
      },
    });
    return;
  }
  if (flavor === "cursor" && ["question", "duplicate_questions", "plan"].includes(text)) {
    const plan = text === "plan";
    update({
      sessionUpdate: "tool_call",
      toolCallId: "extension-tool",
      title: plan ? "Plan" : "Question",
      kind: "other",
      status: "pending",
    });
    pending = "extension-request";
    pendingKind = plan ? "plan" : "question";
    out({
      id: pending,
      method: plan ? "cursor/create_plan" : "cursor/ask_question",
      params: plan
        ? { toolCallId: "extension-tool", plan: "Inspect, change, verify", todos: [] }
        : {
            toolCallId: "extension-tool",
            questions: [
              {
                id: "q1",
                prompt: "Same",
                allowMultiple: true,
                options: [
                  { id: "a", label: "A (Recommended)" },
                  { id: "b", label: "B" },
                ],
              },
              {
                id: "q2",
                prompt: text === "duplicate_questions" ? "Same" : "Next",
                options: [{ id: "c", label: "C" }],
              },
            ],
          },
    });
    return;
  }
  if (text === "slow") {
    timer = setTimeout(() => finish(), 100);
    return;
  }
  if (text === "approval" || text === "crash") {
    update({
      sessionUpdate: "tool_call",
      toolCallId: "approval-tool",
      title: "Read",
      kind: "read",
      status: "pending",
    });
    pendingKind = "permission";
    pending = "permission-1";
    out({
      id: pending,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "approval-tool", title: "Read" },
        options: [
          { optionId: "allow-once-opaque", name: "Allow once", kind: "allow_once" },
          { optionId: "deny-once-opaque", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    if (text === "crash") setTimeout(() => process.exit(1), 30);
    return;
  }
  if (text === "tools") {
    update({
      sessionUpdate: "tool_call",
      toolCallId: "edit",
      title: "Edit",
      kind: "edit",
      rawInput: { path: "safe.txt" },
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit",
      rawOutput: "updated",
      content: [{ type: "diff", path: "safe.txt", oldText: "before", newText: "after" }],
    });
    update({ sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" });
    update({ sessionUpdate: "tool_call", toolCallId: "exec", title: "Run", kind: "execute" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "exec", rawOutput: "exit 1" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "exec", status: "failed" });
  }
  if (text === "unknown") out({ method: "future_event", params: { data: "ignored" } });
  if (text === "malformed") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: 3 } });
    return;
  }
  if (text === "usage")
    update({
      sessionUpdate: "usage_update",
      used: 10,
      size: 100,
      cost: { amount: 0.001, currency: "USD" },
    });
  if (text === "secret_frames")
    out({
      method: "future_event",
      params: { token: "unregistered-secret", value: "seeded-secret" },
    });
  if (text === "host_tools" || text === "delegate" || text in workspaceRequests) {
    if (!host) throw new Error("host_not_injected");
    const response = await callFixtureHost(
      host.url,
      Object.fromEntries(host.headers.map((h) => [h.name, h.value])),
      text in workspaceRequests
        ? workspaceRequests[text]
        : text === "delegate"
          ? {
              name: "team_delegate",
              arguments: {
                key: "feature-check",
                title: "Feature check",
                brief: "Check the feature and return a brief result.",
              },
            }
          : undefined,
    );
    update({
      sessionUpdate: "tool_call",
      toolCallId: "host",
      title: "Host",
      kind: "other",
      status: "completed",
      rawOutput: response,
    });
  }
  finish();
}
process.stderr.write("ZOLTBOT_FAKE_READY\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.id === pending && request.result && pendingKind !== "permission") {
    if (pendingKind === "form") {
      if (request.result.action !== "accept" || request.result.content?.name !== "Verified")
        throw new Error("invalid_elicitation_reply");
      pending = undefined;
      finish();
      continue;
    }
    const outcome = request.result.outcome;
    if (
      pendingKind === "question" &&
      (outcome?.outcome !== "answered" ||
        outcome.answers?.length !== 2 ||
        outcome.answers[1].selectedOptionIds?.[0] !== "c")
    )
      throw new Error("invalid_cursor_question_reply");
    if (pendingKind === "plan" && outcome?.outcome !== "accepted")
      throw new Error("invalid_cursor_plan_reply");
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "extension-tool",
      status: "completed",
      rawOutput: JSON.stringify(request.result),
    });
    pending = undefined;
    finish();
    continue;
  }
  if (request.id === pending && request.result) {
    const allowed = request.result.outcome?.optionId === "allow-once-opaque";
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "approval-tool",
      status: allowed ? "completed" : "failed",
    });
    pending = undefined;
    finish();
    continue;
  }
  switch (request.method) {
    case "initialize":
      reply(request.id, {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp", version: "test-1" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true },
        },
        authMethods: [],
      });
      break;
    case "session/new":
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "fixture", description: "Native fixture command" }],
      });
      host = request.params.mcpServers?.[0];
      writeFileSync(native, JSON.stringify({ sessionId }), { mode: 0o600 });
      reply(request.id, { sessionId });
      break;
    case "session/load":
      if (!existsSync(native) || request.params.sessionId !== sessionId) {
        out({ id: request.id, error: { code: -32001, message: "session_not_found" } });
        break;
      }
      host = request.params.mcpServers?.[0];
      reply(request.id, {});
      break;
    case "session/prompt":
      recordAttachments(
        request.params.prompt
          .filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text),
        request.params.prompt.filter((part: { type: string }) => part.type === "image"),
      );
      promptId = request.id;
      void prompt(
        artifactFixturePrompt(
          request.params.prompt
            .filter((p: { type: string }) => p.type === "text")
            .map((p: { text: string }) => p.text),
        ),
      );
      break;
    case "session/cancel":
      clearTimeout(timer);
      pending = undefined;
      finish("cancelled");
      break;
    default:
      if (request.id !== undefined)
        out({ id: request.id, error: { code: -32601, message: "method_not_found" } });
  }
}
