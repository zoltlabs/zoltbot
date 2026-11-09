// Test-only wire server. Normalized output is deliberate; real provider codecs are tested separately.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent, InteractionDraft } from "@zoltbot/protocol";
import { referenceCapabilities } from "./capabilities.js";

const nativeFile = path.join(process.cwd(), "reference-native.json");
let nativeId = process.env.REFERENCE_NATIVE_ID ?? "fake-session";
let turn = 0;
let busy = false;
let hung = false;
let streamPhase = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { id: string; kind: string } | undefined;
const queue: string[] = [];
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (value: AgentEvent) => out(value);
const reply = (id: unknown, result: unknown) => out({ id, result });
function draft(kind: string): InteractionDraft {
  const question = [
    "question",
    "duplicate_questions",
    "single_question",
    "secret_question",
  ].includes(kind);
  const form = kind === "form" || kind === "unsupported_form";
  return {
    id: "request-1",
    agentId: "profile",
    threadId: "thread",
    turnId: `t${turn}`,
    nativeRef: "native-request-1",
    type: form ? "form" : question ? "question" : kind === "plan" ? "plan" : "approval",
    urgency: "blocking",
    chain: [],
    ...(kind === "plan" ? { context: { markdown: "# Plan\n1. Build carefully" } } : {}),
    ...(kind === "file_approval"
      ? {
          context: {
            toolName: "Write",
            toolKind: "edit" as const,
            paths: [path.join(process.cwd(), "src/a.ts")],
          },
        }
      : {}),
    ...(kind === "command_approval"
      ? {
          context: {
            toolName: "Bash",
            toolKind: "execute" as const,
            command: "git push origin main",
          },
        }
      : {}),
    items:
      kind === "secret_question"
        ? [{ id: "private", prompt: "Private fixture", secret: true, allowOther: false }]
        : kind === "single_question"
          ? [
              {
                id: "color",
                prompt: "Choose a color",
                options: [
                  { id: "a", label: "A", recommended: true },
                  { id: "b", label: "B" },
                ],
                allowOther: true,
              },
            ]
          : form
            ? [
                {
                  id: "settings",
                  prompt: "Report settings",
                  schema:
                    kind === "unsupported_form"
                      ? { type: "object", properties: { nested: { type: "object" } } }
                      : {
                          type: "object",
                          properties: {
                            name: { type: "string", minLength: 2 },
                            count: { type: "integer", minimum: 1 },
                            enabled: { type: "boolean" },
                            format: { enum: ["short", "long"], default: "short" },
                          },
                          required: ["name", "count", "enabled"],
                          additionalProperties: false,
                        },
                },
              ]
            : question
              ? [
                  {
                    id: "q1",
                    prompt: "Choose a database",
                    multi: true,
                    options: [
                      { id: "a", label: "A", recommended: true },
                      { id: "b", label: "B" },
                    ],
                  },
                  {
                    id: "q2",
                    prompt: kind === "duplicate_questions" ? "Choose a database" : "Add a note",
                    allowOther: true,
                  },
                ]
              : [
                  {
                    id: "approve",
                    prompt: "Allow the harmless operation?",
                    choices: [
                      { id: "allow_once" },
                      ...(kind === "approval_session" ? [{ id: "allow_session" as const }] : []),
                      { id: "reject_once" },
                    ],
                  },
                ],
  };
}
function finish(text = process.env.REFERENCE_FINAL_TEXT ?? "ok") {
  event({ t: "message.done", turnId: `t${turn}`, itemId: `m${turn}`, text, phase: "final" });
  event({ t: "turn.done", turnId: `t${turn}`, status: "completed" });
  busy = false;
  pending = undefined;
  const next = queue.shift();
  if (next) void run(next);
}
async function run(text: string) {
  busy = true;
  turn++;
  event({ t: "turn.started", turnId: `t${turn}` });
  if (text.startsWith("/fixture")) {
    finish("Native fixture command handled.");
    return;
  }
  if (text === "private_echo") {
    finish("Private echo: synthetic-private-resume-answer");
    return;
  }
  if (text === "credential_echo") {
    finish(`Environment echo: ${process.env.ZOLTBOT_TEST_API_KEY ?? "missing"}`);
    return;
  }
  if (text === "private_echo_both") {
    finish("Private echo: synthetic-private-resume-answer synthetic-private-second-answer");
    return;
  }
  if (text === "benchmark60") {
    const ownTurn = turn,
      start = performance.now();
    let content = "";
    for (let index = 0; index < 120; index++) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, start + (index * 1000) / 60 - performance.now())),
      );
      if (!busy || turn !== ownTurn) return;
      const chunk = `frame${String(index).padStart(3, "0")}:${Date.now()}|`;
      content += chunk;
      event({ t: "text.delta", turnId: `t${ownTurn}`, itemId: `m${ownTurn}`, text: chunk });
    }
    finish(content);
    return;
  }
  if (text === "stream_pause") {
    streamPhase = 1;
    event({
      t: "text.delta",
      turnId: `t${turn}`,
      itemId: `m${turn}`,
      text: "visible synthetic-private-",
    });
    return;
  }
  if (text === "hang") {
    hung = true;
    return;
  }
  if (text === "auth_required") {
    event({ t: "status", state: "auth_required", detail: "synthetic-private-auth-detail" });
    return;
  }
  if (text === "slow") {
    timer = setTimeout(() => finish(), 70);
    return;
  }
  if (
    [
      "approval",
      "file_approval",
      "command_approval",
      "question",
      "duplicate_questions",
      "single_question",
      "secret_question",
      "approval_session",
      "plan",
      "crash",
      "form",
      "unsupported_form",
    ].includes(text)
  ) {
    const interaction = draft(text === "crash" ? "approval" : text);
    pending = { id: interaction.id, kind: text };
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: "tool-approval",
      name: "Read",
      kind: "read",
      input: { path: "safe.txt" },
    });
    event({ t: "interaction.requested", interaction });
    if (text === "crash") setTimeout(() => process.exit(1), 10);
    return;
  }
  if (text === "retry_tools") {
    // A command that fails, then passes on the agent's second try.
    for (const [attempt, status] of [
      [1, "error"],
      [2, "ok"],
    ] as const) {
      event({
        t: "tool.started",
        turnId: `t${turn}`,
        itemId: `retry${turn}-${attempt}`,
        name: "Shell",
        kind: "execute",
        input: { command: "pnpm test" },
        title: "pnpm test",
      });
      event({ t: "tool.done", itemId: `retry${turn}-${attempt}`, status, output: status });
    }
  }
  if (text === "live_tools") {
    // A read that finished and a command still running, so the live state can be seen.
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: `read${turn}`,
      name: "Read",
      kind: "read",
      input: { path: "src/app.ts" },
      title: "Read src/app.ts",
    });
    event({ t: "tool.done", itemId: `read${turn}`, status: "ok", output: "export {}" });
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: `test${turn}`,
      name: "Shell",
      kind: "execute",
      input: { command: "pnpm test" },
      title: "pnpm test",
    });
    timer = setTimeout(
      () => {
        event({ t: "tool.done", itemId: `test${turn}`, status: "ok", output: "passed" });
        finish("Tests pass.");
      },
      Number(process.env.REFERENCE_LIVE_TOOLS_MS ?? 4000),
    );
    return;
  }
  if (text === "tools") {
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: "edit",
      name: "Edit",
      kind: "edit",
      input: { path: "safe.txt" },
    });
    event({ t: "tool.updated", itemId: "edit", output: "updated" });
    event({
      t: "tool.done",
      itemId: "edit",
      status: "ok",
      diffs: [{ path: "safe.txt", before: "a", after: "b" }],
    });
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: "exec",
      name: "Shell",
      kind: "execute",
      input: { command: "false" },
    });
    event({ t: "tool.updated", itemId: "exec", output: "exit code 1" });
    event({ t: "tool.done", itemId: "exec", status: "error", output: "failed" });
  }
  if (text === "background") {
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: "bg-tool",
      name: "Bash",
      kind: "execute",
      input: { command: "npm run dev", run_in_background: true },
      title: "npm run dev",
    });
    event({
      t: "background.updated",
      task: {
        id: "bg-1",
        kind: "shell",
        description: "npm run dev",
        state: "running",
        toolItemId: "bg-tool",
        startedAt: new Date().toISOString(),
      },
    });
    event({ t: "tool.done", itemId: "bg-tool", status: "ok", output: "started bg-1" });
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: "ask-tool",
      name: "AskUserQuestion",
      kind: "other",
      input: {},
      title: "Which port?",
      interactive: true,
    });
    event({ t: "tool.done", itemId: "ask-tool", status: "ok", output: "3000" });
  }
  if (text === "unknown") out({ t: "future_event", body: "ignored" });
  if (text === "malformed") {
    out({ t: "text.delta", turnId: `t${turn}`, itemId: "m", text: 3 });
    return;
  }
  if (text === "secret_frames")
    out({ t: "future_event", token: "unregistered-private-value", body: "seeded-secret" });
  if (text === "usage") {
    event({
      t: "usage.updated",
      turnId: `t${turn}`,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 8,
        costUsd: 0.001,
        cumulative: false,
      },
    });
    event({
      t: "usage.updated",
      usage: {
        inputTokens: 30,
        outputTokens: 6,
        cacheReadTokens: 24,
        costUsd: 0.003,
        cumulative: true,
      },
    });
  }
  if (text === "host_tools") {
    const response = await fetch(process.env.HOST_URL ?? "", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HOST_TOKEN ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool: "team_list_agents" }),
    });
    const output = await response.text();
    event({
      t: "tool.started",
      turnId: `t${turn}`,
      itemId: "host",
      name: "team_list_agents",
      kind: "other",
      input: {},
    });
    event({ t: "tool.done", itemId: "host", status: response.ok ? "ok" : "error", output });
  }
  event({ t: "text.delta", turnId: `t${turn}`, itemId: `m${turn}`, text: "o" });
  event({ t: "text.delta", turnId: `t${turn}`, itemId: `m${turn}`, text: "k" });
  finish();
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const { id, method, params } = JSON.parse(line) as {
    id: number;
    method: string;
    params: Record<string, unknown>;
  };
  if (hung) continue;
  if (method === "open") {
    if (params.mode === "resume") {
      if (!existsSync(nativeFile)) {
        out({ id, error: "native_session_missing" });
        continue;
      }
      nativeId = JSON.parse(readFileSync(nativeFile, "utf8")).id;
      if (params.nativeId !== nativeId) {
        out({ id, error: "wrong_native_id" });
        continue;
      }
    } else writeFileSync(nativeFile, JSON.stringify({ id: nativeId }), { mode: 0o600 });
    reply(id, { nativeId, capabilities: referenceCapabilities });
    event({
      t: "session.ready",
      nativeId,
      capabilities: referenceCapabilities,
      providerVersion: "test-1",
    });
  } else if (method === "send") {
    const parts = params.input as { type: string; text?: string }[];
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (busy && params.mode === "steer") {
      event({ t: "text.delta", turnId: `t${turn}`, itemId: `m${turn}`, text });
      reply(id, { disposition: "started" });
    } else if (busy) {
      queue.push(text);
      reply(id, { disposition: "queued" });
    } else {
      reply(id, { disposition: "started" });
      void run(text);
    }
  } else if (method === "respond") {
    if (!pending || params.id !== pending.id) {
      out({ id, error: "unmatched_interaction" });
      continue;
    }
    const answer = params.answer as { choice?: string; action?: string; answers?: unknown };
    const witness =
      pending.kind === "duplicate_questions" && answer.action === "accept"
        ? `Native answer SHA256: ${createHash("sha256").update(JSON.stringify(answer.answers)).digest("hex")}`
        : undefined;
    reply(id, {});
    event({
      t: "tool.done",
      itemId: "tool-approval",
      status:
        answer.choice === "reject_once" || answer.action === "decline" || answer.action === "cancel"
          ? "denied"
          : "ok",
      output: answer,
    });
    event({ t: "interaction.cleared", nativeRef: "native-request-1", reason: "provider_resolved" });
    finish(witness);
  } else if (method === "interrupt") {
    clearTimeout(timer);
    event({ t: "turn.done", turnId: `t${turn}`, status: "interrupted" });
    busy = false;
    reply(id, {});
  } else if (method === "compact") {
    event({ t: "compaction", state: "started", trigger: "manual" });
    event({ t: "compaction", state: "done", trigger: "manual" });
    reply(id, {});
  } else if (method === "advance_stream") {
    if (streamPhase === 1) {
      streamPhase = 2;
      event({ t: "text.delta", turnId: `t${turn}`, itemId: `m${turn}`, text: "live-" });
    } else if (streamPhase === 2) {
      streamPhase = 0;
      event({ t: "text.delta", turnId: `t${turn}`, itemId: `m${turn}`, text: "value done" });
      finish("visible synthetic-private-live-value done");
    }
    reply(id, {});
  } else if (method === "setMode") {
    reply(id, {});
    event({ t: "mode.changed", mode: String(params.mode) });
  } else if (method === "stopBackground") {
    if (params.taskId !== "bg-1") {
      out({ id, error: "unknown_background_task" });
      continue;
    }
    reply(id, {});
    event({
      t: "background.updated",
      task: {
        id: "bg-1",
        kind: "shell",
        description: "npm run dev",
        state: "stopped",
        endedAt: new Date().toISOString(),
      },
    });
  } else if (method === "rewindFiles") {
    if (typeof params.turnId !== "string" || !/^t\d+$/.test(params.turnId)) {
      out({ id, error: "unknown_turn" });
      continue;
    }
    reply(id, { canRewind: true, files: ["safe.txt"], insertions: 1, deletions: 2 });
  } else if (method === "environment") reply(id, process.env);
  else if (method === "contextUsage") reply(id, { used: 20, size: 1000 });
  else reply(id, {});
}
clearTimeout(timer);
