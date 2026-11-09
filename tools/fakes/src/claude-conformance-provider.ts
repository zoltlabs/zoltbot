// Stateful synthetic stream-json provider. Turn fixtures remain provisional until the real canary.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { recordAttachments } from "./attachment-receipt.js";
import { artifactFixturePrompt, callFixtureHost, workspaceRequests } from "./host-mcp-call.js";

const args = process.argv.slice(2);
// The Agent SDK passes most flags as --name=value.
const flag = (name: string) => {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
};
const managedCommands = args.flatMap((arg, index) => {
  if (arg !== "--plugin-dir" && !arg.startsWith("--plugin-dir=")) return [];
  const root = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  if (!root) return [];
  const manifest = JSON.parse(readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
  return readdirSync(path.join(root, "skills")).map((name) => ({
    name: `${manifest.name}:${name}`,
    description: "Managed native fixture skill",
  }));
});
const nativeFile = path.join(process.cwd(), "claude-native.json");
const sessions: Record<string, { title?: string }> = existsSync(nativeFile)
  ? JSON.parse(readFileSync(nativeFile, "utf8"))
  : {};
const nativeId = flag("--session-id") ?? flag("--resume") ?? "fake-session";
let mode = flag("--permission-mode") ?? "default";
const bypassAvailable =
  mode === "bypassPermissions" || args.includes("--allow-dangerously-skip-permissions");
let mcpChecks = 0;
const liveModel: { model?: string; effortLevel?: string | null } = {};
const configPath = flag("--mcp-config");
const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const host = config.mcpServers?.zoltbot;
const title = flag("-n") ?? flag("--name");
// The Agent SDK sends the system prompt append in its initialize request.
let appendSystemPrompt = flag("--append-system-prompt");
sessions[nativeId] = { ...(title ? { title } : {}) };
writeFileSync(nativeFile, JSON.stringify(sessions), { mode: 0o600 });
writeFileSync(
  path.join(process.cwd(), "environment-keys.json"),
  JSON.stringify(Object.fromEntries(Object.keys(process.env).map((k) => [k, "present"]))),
  { mode: 0o600 },
);
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (id: string, value: unknown) =>
  out({
    type: "control_response",
    response: { subtype: "success", request_id: id, response: value },
  });
let turn = 0;
let busy = false;
let hung = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { id: string; kind: string } | undefined;
let total = 0;
const tasks = new Set<string>();
const checkpoints = new Set<string>();
const rewound: string[] = [];
function finish(interrupted = false, reply = "ok") {
  if (!interrupted)
    out({
      type: "assistant",
      session_id: nativeId,
      message: {
        id: `message-${turn}`,
        role: "assistant",
        content: [{ type: "text", text: reply }],
      },
    });
  out({
    type: "result",
    session_id: nativeId,
    subtype: interrupted ? "error_during_execution" : "success",
    is_error: interrupted,
    result: interrupted ? "" : reply,
    // Claude sends an errors list with every error result; the Agent SDK reads it.
    ...(interrupted ? { errors: [] } : {}),
    usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 8 },
    modelUsage: {
      model: {
        inputTokens: total * 2,
        outputTokens: total * 2,
        cacheReadInputTokens: total * 8,
        cacheCreationInputTokens: 0,
      },
    },
    total_cost_usd: total * 0.001,
  });
  busy = false;
  pending = undefined;
}
function toolResult(id: string, output: unknown, isError = false) {
  out({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }],
    },
  });
}
async function run(text: string) {
  text = artifactFixturePrompt([text]);
  turn++;
  total++;
  busy = true;
  out({
    type: "system",
    subtype: "init",
    session_id: nativeId,
    model: "model",
    permissionMode: mode,
    mcp_servers: [{ name: "zoltbot", status: "connected" }],
    tools: ["mcp__zoltbot__spike_ping"],
  });
  out({
    type: "stream_event",
    event: { type: "message_start", message: { id: `message-${turn}` } },
  });
  if (appendSystemPrompt?.includes("Classify the request as chat, single_task, or phased_task.")) {
    const reply = JSON.stringify({ intent: "chat", phases: [] });
    out({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } },
    });
    finish(false, reply);
    return;
  }
  if (text === "hang") {
    hung = true;
    return;
  }
  if (text === "slow") {
    timer = setTimeout(() => finish(), 500);
    return;
  }
  if (
    [
      "approval",
      "question",
      "duplicate_questions",
      "plan",
      "plan_file",
      "plan_stripped",
      "crash",
      "suggestions",
    ].includes(text)
  ) {
    const question = text === "question" || text === "duplicate_questions";
    const plan = text === "plan" || text === "plan_file" || text === "plan_stripped";
    const toolName = question ? "AskUserQuestion" : plan ? "ExitPlanMode" : "Bash";
    const input = question
      ? {
          questions: [
            {
              header: "First",
              question: "Choose",
              multiSelect: true,
              options: [
                { label: "A (Recommended)", description: "A" },
                { label: "B", description: "B" },
              ],
            },
            {
              header: "Second",
              question: text === "duplicate_questions" ? "Choose" : "Add a note",
              options: [],
            },
          ],
        }
      : text === "plan"
        ? { plan: "# Plan\nBuild and test." }
        : text === "plan_file" || text === "plan_stripped"
          ? {}
          : text === "suggestions"
            ? { command: "npm test --watch" }
            : { command: "cat safe.txt" };
    // Real Claude 2.1.316 sends ExitPlanMode with empty input after a blocked plan file write,
    // and strips the plan from the permission request when no plan file was written.
    const callInput = text === "plan_stripped" ? { plan: "# Plan\nFrom call." } : input;
    if (text === "plan_file")
      out({
        type: "assistant",
        message: {
          id: `plan-write-${turn}`,
          content: [
            {
              type: "tool_use",
              id: "plan-write",
              name: "Write",
              input: { file_path: "/home/.claude/plans/canary.md", content: "# Plan\nFrom file." },
            },
          ],
        },
      });
    pending = { id: `request-${turn}`, kind: text };
    out({
      type: "assistant",
      message: {
        id: `tool-message-${turn}`,
        content: [{ type: "tool_use", id: "approval-tool", name: toolName, input: callInput }],
      },
    });
    out({
      type: "control_request",
      request_id: pending.id,
      request: {
        subtype: "can_use_tool",
        tool_name: toolName,
        tool_use_id: "approval-tool",
        input,
        ...(text === "suggestions"
          ? {
              permission_suggestions: [
                {
                  type: "addRules",
                  rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
                  behavior: "allow",
                  destination: "localSettings",
                },
              ],
            }
          : {}),
      },
    });
    if (text === "crash") setTimeout(() => process.exit(1), 30);
    return;
  }
  if (text === "tools") {
    out({
      type: "assistant",
      message: {
        id: "tools",
        content: [
          {
            type: "tool_use",
            id: "edit",
            name: "Edit",
            input: { file_path: "safe.txt", old_string: "before", new_string: "after" },
          },
          { type: "tool_use", id: "exec", name: "Bash", input: { command: "false" } },
        ],
      },
    });
    toolResult("edit", "updated");
    toolResult("exec", "exit 1", true);
  }
  if (text === "background") {
    // Shape from Claude 2.1.42: the Bash result names the task and tool_use_result carries its id.
    out({
      type: "assistant",
      message: {
        id: "background-message",
        content: [
          {
            type: "tool_use",
            id: "background-tool",
            name: "Bash",
            input: { command: "npm run watch", description: "Watch", run_in_background: true },
          },
        ],
      },
    });
    tasks.add("shell-1");
    out({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "background-tool",
            content:
              "Command running in background with ID: shell-1. Output is being written to: /tmp/shell-1.output",
          },
        ],
      },
      tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "shell-1" },
    });
    tasks.add("agent-1");
    out({
      type: "system",
      subtype: "task_started",
      task_id: "agent-1",
      description: "Review",
      task_type: "local_agent",
    });
    // Notifications arrive between turns.
    setTimeout(() => {
      tasks.delete("agent-1");
      out({
        type: "system",
        subtype: "task_notification",
        task_id: "agent-1",
        status: "completed",
        output_file: "",
        summary: "Reviewed",
        session_id: nativeId,
      });
    }, 100);
  }
  if (text === "elicitation" || text === "elicitation_url") {
    pending = { id: `request-${turn}`, kind: text };
    out({
      type: "control_request",
      request_id: pending.id,
      request: {
        subtype: "elicitation",
        mcp_server_name: "fixture",
        message: "Pick a name",
        ...(text === "elicitation_url"
          ? { mode: "url", url: "https://example.com/authorize" }
          : {
              mode: "form",
              requested_schema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            }),
      },
    });
    return;
  }
  if (text === "unknown") out({ type: "future_event", value: "ignored" });
  if (text === "malformed") {
    out({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: 3 } },
    });
    return;
  }
  if (text === "secret_frames")
    out({ type: "future_event", token: "unregistered-private-value", value: "seeded-secret" });
  if (
    text === "host_tools" ||
    text === "delegate" ||
    text === "delegate_codex" ||
    text in workspaceRequests
  ) {
    if (!host) throw new Error("host_missing");
    const result = await callFixtureHost(
      host.url,
      host.headers,
      text in workspaceRequests
        ? workspaceRequests[text]
        : text === "delegate" || text === "delegate_codex"
          ? {
              name: "team_delegate",
              arguments: {
                key: "feature-check",
                title: "Feature check",
                brief: "Check the feature and return a brief result.",
                ...(text === "delegate_codex" ? { profileId: "codex-profile" } : {}),
              },
            }
          : undefined,
    );
    out({
      type: "assistant",
      message: {
        id: "host-message",
        content: [{ type: "tool_use", id: "host", name: "mcp__zoltbot__ping", input: {} }],
      },
    });
    toolResult("host", result);
  }
  out({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
  });
  finish();
}
process.stderr.write("ZOLTBOT_FAKE_READY\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    const id = message.request_id,
      request = message.request;
    if (hung) continue;
    switch (request.subtype) {
      case "initialize":
        if (typeof request.appendSystemPrompt === "string")
          appendSystemPrompt = request.appendSystemPrompt;
        // The Agent SDK names a new session through initialize.
        if (typeof request.title === "string") {
          sessions[nativeId] = { title: request.title };
          writeFileSync(nativeFile, JSON.stringify(sessions), { mode: 0o600 });
        }
        response(id, {
          claude_code_version: "2.1.299",
          current_permission_mode: mode,
          session_state: "idle",
          capabilities: [],
          commands: [
            { name: "fixture", description: "Native fixture command" },
            ...managedCommands,
          ],
          models: [{ value: "model", displayName: "Model" }],
        });
        break;
      case "mcp_status":
        // Claude 2.1.316 reports HTTP servers as pending until their background connect ends.
        response(id, {
          mcpServers: [{ name: "zoltbot", status: mcpChecks++ ? "connected" : "pending" }],
        });
        break;
      case "get_context_usage":
        response(id, { totalTokens: 20, maxTokens: 100 });
        break;
      case "set_permission_mode": {
        // Claude 2.1.42 offers bypassPermissions only when launched in it or with
        // --allow-dangerously-skip-permissions. refuse-modes.json lets tests refuse others.
        const refusePath = path.join(process.cwd(), "refuse-modes.json");
        const refused = existsSync(refusePath) ? JSON.parse(readFileSync(refusePath, "utf8")) : [];
        if (
          refused.includes(request.mode) ||
          (request.mode === "bypassPermissions" && !bypassAvailable)
        ) {
          out({
            type: "control_response",
            response: { subtype: "error", request_id: id, error: "mode unavailable" },
          });
          break;
        }
        mode = request.mode;
        response(id, { mode });
        break;
      }
      case "set_model":
        liveModel.model = request.model;
        writeFileSync(path.join(process.cwd(), "live-model.json"), JSON.stringify(liveModel), {
          mode: 0o600,
        });
        response(id, {});
        break;
      case "apply_flag_settings":
        if (request.settings && "effortLevel" in request.settings)
          liveModel.effortLevel = request.settings.effortLevel;
        writeFileSync(path.join(process.cwd(), "live-model.json"), JSON.stringify(liveModel), {
          mode: 0o600,
        });
        response(id, {});
        break;
      case "stop_task":
        if (!tasks.has(request.task_id)) {
          out({
            type: "control_response",
            response: { subtype: "error", request_id: id, error: "No task found" },
          });
          break;
        }
        tasks.delete(request.task_id);
        response(id, {});
        out({
          type: "system",
          subtype: "task_notification",
          task_id: request.task_id,
          status: "stopped",
          output_file: "",
          summary: "Stopped",
          session_id: nativeId,
        });
        break;
      case "rewind_files":
        // Claude 2.1.42 answers a dry run with counts and a real rewind with canRewind only.
        if (!checkpoints.has(request.user_message_id))
          response(id, { canRewind: false, error: "No file checkpoint found for this message." });
        else if (request.dry_run)
          response(id, {
            canRewind: true,
            filesChanged: ["safe.txt"],
            insertions: 2,
            deletions: 1,
          });
        else {
          rewound.push(request.user_message_id);
          writeFileSync(path.join(process.cwd(), "rewound.json"), JSON.stringify(rewound), {
            mode: 0o600,
          });
          response(id, { canRewind: true });
        }
        break;
      case "interrupt":
        clearTimeout(timer);
        response(id, { still_queued: [] });
        if (busy) finish(true);
        break;
      default:
        out({
          type: "control_response",
          response: { subtype: "error", request_id: id, error: "unknown_control" },
        });
    }
    continue;
  }
  if (message.type === "control_response" && pending) {
    if (message.response.request_id !== pending.id || message.response.subtype !== "success")
      throw new Error("invalid_control_response");
    const reply = message.response.response;
    if (pending.kind.startsWith("elicitation")) {
      if (!["accept", "decline", "cancel"].includes(reply.action))
        throw new Error("invalid_elicitation_action");
      out({
        type: "assistant",
        message: {
          id: `elicitation-result-${turn}`,
          content: [{ type: "text", text: `elicitation ${JSON.stringify(reply)}` }],
        },
      });
      finish();
      continue;
    }
    if (!["allow", "deny"].includes(reply.behavior)) throw new Error("invalid_permission_behavior");
    // Record native grants so tests can check that nothing targets settings files.
    if (reply.updatedPermissions) {
      if (!Array.isArray(reply.updatedPermissions)) throw new Error("invalid_permission_updates");
      for (const update of reply.updatedPermissions) {
        if (update.destination !== "session") throw new Error("persistent_permission_update");
        // A refused mode is ignored silently, as a permission answer has no acknowledgement.
        const refusePath = path.join(process.cwd(), "refuse-modes.json");
        const refused = existsSync(refusePath) ? JSON.parse(readFileSync(refusePath, "utf8")) : [];
        if (update.type === "setMode" && !refused.includes(update.mode)) mode = update.mode;
      }
      writeFileSync(
        path.join(process.cwd(), "permission-updates.json"),
        JSON.stringify(reply.updatedPermissions),
        { mode: 0o600 },
      );
    }
    if (
      reply.behavior === "allow" &&
      (!reply.updatedInput || typeof reply.updatedInput !== "object")
    )
      throw new Error("updated_input_required");
    toolResult(
      "approval-tool",
      pending.kind === "question" || pending.kind === "duplicate_questions"
        ? JSON.stringify(reply.updatedInput?.answers)
        : pending.kind.startsWith("plan") && reply.behavior === "allow"
          ? `User has approved your plan: ${reply.updatedInput?.plan ?? ""}`
          : "answered",
      reply.behavior !== "allow",
    );
    finish();
    continue;
  }
  if (message.type === "user") {
    recordAttachments(
      message.message.content
        .filter((part: { type: string }) => part.type === "text")
        .map((part: { text: string }) => part.text),
      message.message.content
        .filter((part: { type: string }) => part.type === "image")
        .map((part: { source: { data: string; media_type: string } }) => ({
          data: part.source.data,
          mimeType: part.source.media_type,
        })),
    );
    const text = message.message.content
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text: string }) => p.text)
      .join("\n");
    if (text.startsWith("/compact")) {
      if (busy) throw new Error("concurrent_turn_not_allowed");
      out({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 20 },
      });
      out({
        type: "result",
        session_id: nativeId,
        subtype: "success",
        is_error: false,
        result: "",
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      continue;
    }
    // --replay-user-messages echoes the input with the uuid the client supplied.
    if (typeof message.uuid === "string" && args.includes("--replay-user-messages")) {
      checkpoints.add(message.uuid);
      out({ ...message, session_id: nativeId, isReplay: true });
    }
    if (text.startsWith("/rename ")) {
      sessions[nativeId] = { title: text.slice(8) };
      writeFileSync(nativeFile, JSON.stringify(sessions), { mode: 0o600 });
      continue;
    }
    // A priority "now" input ends the running segment, and the turn goes on with it.
    if (busy && message.priority === "now") {
      clearTimeout(timer);
      out({
        type: "result",
        session_id: nativeId,
        // Claude 2.1.319 reports the ended segment as a success with this terminal reason.
        subtype: "success",
        is_error: false,
        terminal_reason: "aborted_tools",
        result: "",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      busy = true;
      out({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      });
      finish(false, text);
      continue;
    }
    if (busy) throw new Error("concurrent_turn_not_allowed");
    void run(text);
  }
}
