// Stateful Codex wire fake. Incoming calls and server replies use the real generated schema.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Ajv } from "ajv";
import { recordAttachments } from "./attachment-receipt.js";
import { artifactFixturePrompt, callFixtureHost, workspaceRequests } from "./host-mcp-call.js";

const bundle = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/codex/0.164.0/protocol-experimental.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false, validateFormats: false });
const validateRequest: (value: unknown) => boolean = ajv.compile({
  definitions: bundle.definitions,
  $ref: "#/definitions/ClientRequest",
});
const valid = (name: string, value: unknown) =>
  ajv.compile({
    definitions: bundle.definitions,
    $ref: `#/definitions/${name in bundle.definitions.v2 ? `v2/${name}` : name}`,
  })(value);
const capture = readFileSync(
  new URL("../../../fixtures/codex/0.164.0/thread-start-no-auth.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const template = capture.find((r) => r.direction === "stdout" && r.message.id === 2).message.result;
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id: unknown, result: unknown) => out({ id, result });
const nativeFile = path.join(process.cwd(), "codex-native.json");
const threads: Record<string, { cwd: string }> = existsSync(nativeFile)
  ? JSON.parse(readFileSync(nativeFile, "utf8"))
  : {};
const hosts = new Map<string, { url: string; http_headers: Record<string, string> }>();
const pending = new Map<
  string,
  { method: string; threadId: string; turnId: string; kind: string }
>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const active = new Map<string, string>();
let initialized = false;
let handshake = false;
let turn = 0;
let hung = false;
writeFileSync(
  path.join(process.cwd(), "environment-keys.json"),
  JSON.stringify(Object.fromEntries(Object.keys(process.env).map((k) => [k, "present"]))),
  { mode: 0o600 },
);
const notify = (method: string, params: unknown) => out({ method, params });
function item(threadId: string, turnId: string, value: Record<string, unknown>, completed = true) {
  notify(completed ? "item/completed" : "item/started", {
    threadId,
    turnId,
    item: value,
    ...(completed ? { completedAtMs: 0 } : { startedAtMs: 0 }),
  });
}
function finish(threadId: string, turnId: string, status = "completed") {
  if (status === "completed")
    item(threadId, turnId, {
      type: "agentMessage",
      id: `message-${turnId}`,
      text: "ok",
      phase: "final_answer",
    });
  active.delete(threadId);
  notify("turn/completed", { threadId, turn: { id: turnId, items: [], status } });
}
async function run(threadId: string, turnId: string, text: string) {
  text = artifactFixturePrompt([text]);
  if (text === "hang") {
    hung = true;
    return;
  }
  if (text === "slow") {
    if (["steer", "interrupt"].includes(process.env.CODEX_TEST_SCENARIO ?? "")) return;
    timers.set(
      threadId,
      setTimeout(() => finish(threadId, turnId), 500),
    );
    return;
  }
  if (["approval", "crash", "question", "duplicate_questions"].includes(text)) {
    const question = text === "question" || text === "duplicate_questions";
    const method = question
      ? "item/tool/requestUserInput"
      : "item/commandExecution/requestApproval";
    const id = `request-${turnId}`;
    pending.set(id, { method, threadId, turnId, kind: text });
    out({
      id,
      method,
      params: question
        ? {
            threadId,
            turnId,
            itemId: "question",
            isBlocking: true,
            questions: [
              {
                id: "q1",
                header: "First",
                question: "Choose",
                multiSelect: true,
                options: [
                  { label: "A (Recommended)", description: "A" },
                  { label: "B", description: "B" },
                ],
              },
              {
                id: "q2",
                header: "Second",
                question: text === "duplicate_questions" ? "Choose" : "Add a note",
                isOther: true,
              },
            ],
          }
        : {
            threadId,
            turnId,
            itemId: "approval",
            command: "cat safe.txt",
            cwd: process.cwd(),
            startedAtMs: 0,
          },
    });
    if (text === "crash") setTimeout(() => process.exit(1), 30);
    return;
  }
  if (text === "tools") {
    const command = {
      type: "commandExecution",
      id: "exec",
      command: "false",
      cwd: process.cwd(),
      commandActions: [],
    };
    item(threadId, turnId, { ...command, status: "inProgress" }, false);
    notify("item/commandExecution/outputDelta", {
      threadId,
      turnId,
      itemId: "exec",
      delta: "exit 1",
    });
    item(threadId, turnId, { ...command, status: "failed", aggregatedOutput: "exit 1" });
    item(threadId, turnId, {
      type: "fileChange",
      id: "edit",
      status: "completed",
      changes: [{ path: "safe.txt", kind: { type: "update" }, diff: "@@\n-before\n+after" }],
    });
  }
  if (text === "unknown") notify("future_event", { value: "ignored" });
  if (text === "malformed") {
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "m", delta: 3 });
    return;
  }
  if (text === "secret_frames")
    notify("future_event", { token: "unregistered-private-value", value: "seeded-secret" });
  if (text === "usage")
    notify("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        modelContextWindow: 100,
        last: {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 8,
          reasoningOutputTokens: 1,
          totalTokens: 12,
        },
        total: {
          inputTokens: 30,
          outputTokens: 6,
          cachedInputTokens: 24,
          reasoningOutputTokens: 3,
          totalTokens: 36,
        },
      },
    });
  if (text === "host_tools" || text === "delegate" || text in workspaceRequests) {
    const host = hosts.get(threadId);
    if (!host) throw new Error("host_missing");
    const result = await callFixtureHost(
      host.url,
      host.http_headers,
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
    item(threadId, turnId, {
      type: "mcpToolCall",
      id: "host",
      server: "zoltbot",
      tool: "ping",
      arguments: {},
      status: "completed",
      result: { content: [{ type: "text", text: result }] },
    });
  }
  notify("item/agentMessage/delta", { threadId, turnId, itemId: `message-${turnId}`, delta: "ok" });
  finish(threadId, turnId);
}
process.stderr.write("ZOLTBOT_FAKE_READY\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (pending.has(message.id) && "result" in message) {
    const request = pending.get(message.id);
    if (!request) throw new Error("pending_missing");
    const question = request.method === "item/tool/requestUserInput";
    if (
      !valid(
        question ? "ToolRequestUserInputResponse" : "CommandExecutionRequestApprovalResponse",
        message.result,
      )
    )
      throw new Error("invalid_server_reply");
    pending.delete(message.id);
    item(request.threadId, request.turnId, {
      type: "commandExecution",
      id: "approval",
      command: "cat safe.txt",
      cwd: process.cwd(),
      commandActions: [],
      status: question || message.result.decision.startsWith("accept") ? "completed" : "declined",
      aggregatedOutput: question ? JSON.stringify(message.result.answers) : "answered",
    });
    finish(request.threadId, request.turnId);
    continue;
  }
  if (hung) continue;
  if (message.method === "initialized") {
    if (!initialized) throw new Error("initialize_missing");
    handshake = true;
    continue;
  }
  if (!validateRequest(message)) throw new Error("request_schema_failed");
  if (message.method !== "initialize" && !handshake) throw new Error("handshake_missing");
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      initialized = true;
      reply(message.id, {
        userAgent: "fake-codex",
        codexHome: "/work/repo/.codex",
        platformFamily: "unix",
        platformOs: "macos",
      });
      break;
    case "account/read":
      reply(message.id, { account: { type: "apiKey" }, requiresOpenaiAuth: true });
      break;
    case "thread/start":
    case "thread/resume":
    case "thread/fork": {
      const id =
        message.method === "thread/resume" ? params.threadId : `fake-thread-${randomUUID()}`;
      if (message.method === "thread/resume" && !threads[id]) {
        out({ id: message.id, error: { code: -32001, message: "session_not_found" } });
        break;
      }
      threads[id] = { cwd: params.cwd ?? process.cwd() };
      writeFileSync(nativeFile, JSON.stringify(threads), { mode: 0o600 });
      const host = params.config?.mcp_servers?.zoltbot;
      if (host) hosts.set(id, host);
      const response = structuredClone(template);
      response.thread.id = id;
      response.cwd = threads[id]?.cwd;
      response.thread.cwd = threads[id]?.cwd;
      reply(message.id, response);
      break;
    }
    case "thread/list": {
      const data = Object.entries(threads)
        .filter(([, thread]) => !params.cwd || params.cwd === thread.cwd)
        .map(([id, thread]) => ({ ...structuredClone(template.thread), id, cwd: thread.cwd }));
      reply(message.id, { data, readStates: {}, nextCursor: null, backwardsCursor: null });
      break;
    }
    case "turn/start": {
      recordAttachments(
        params.input
          .filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text),
        params.input
          .filter((part: { type: string }) => ["localImage", "image"].includes(part.type))
          .map((part: { type: string; path?: string; url?: string }) => ({
            data:
              part.type === "localImage"
                ? readFileSync(part.path ?? "").toString("base64")
                : part.url?.split(",")[1],
            mimeType: "image/png",
          })),
      );
      const id = `turn-${++turn}`;
      active.set(params.threadId, id);
      reply(message.id, { turn: { id, items: [], status: "inProgress" } });
      notify("turn/started", {
        threadId: params.threadId,
        turn: { id, items: [], status: "inProgress" },
      });
      void run(
        params.threadId,
        id,
        params.input
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { text: string }) => p.text)
          .join("\n"),
      );
      break;
    }
    case "turn/steer": {
      if (active.get(params.threadId) !== params.expectedTurnId)
        throw new Error("stale_turn_fence");
      notify("item/agentMessage/delta", {
        threadId: params.threadId,
        turnId: params.expectedTurnId,
        itemId: "steer",
        delta: "steered",
      });
      reply(message.id, { turnId: params.expectedTurnId });
      if (process.env.CODEX_TEST_SCENARIO === "steer")
        finish(params.threadId, params.expectedTurnId);
      break;
    }
    case "turn/interrupt":
      clearTimeout(timers.get(params.threadId));
      reply(message.id, {});
      if (active.get(params.threadId) === params.turnId)
        finish(params.threadId, params.turnId, "interrupted");
      break;
    case "thread/compact/start": {
      const t = `compact-${++turn}`;
      item(params.threadId, t, { type: "contextCompaction", id: t }, false);
      item(params.threadId, t, { type: "contextCompaction", id: t });
      reply(message.id, {});
      break;
    }
    case "thread/name/set":
      reply(message.id, {});
      break;
    case "config/read":
      reply(message.id, { config: {}, origins: {}, layers: null });
      break;
    default:
      out({ id: message.id, error: { code: -32601, message: "unsupported_fake_method" } });
  }
}
