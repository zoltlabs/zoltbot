import type { AgentEvent, UsageSample } from "@zoltbot/protocol";
import { object } from "./schema.js";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) => (typeof value === "number" ? Math.max(0, value) : 0);
function usage(value: unknown, cumulative: boolean, window: unknown): UsageSample {
  const tokens = object(value);
  return {
    inputTokens: number(tokens.inputTokens),
    outputTokens: number(tokens.outputTokens),
    cacheReadTokens: number(tokens.cachedInputTokens),
    ...(typeof tokens.cacheWriteInputTokens === "number"
      ? { cacheWriteTokens: number(tokens.cacheWriteInputTokens) }
      : {}),
    reasoningTokens: number(tokens.reasoningOutputTokens),
    contextUsed: number(tokens.totalTokens),
    ...(typeof window === "number" && window > 0 ? { contextSize: window } : {}),
    cumulative,
  };
}
export function codexNotification(
  method: string,
  params: Record<string, unknown>,
  compactionTrigger: "auto" | "manual" = "auto",
): AgentEvent[] {
  const turnId = text(params.turnId);
  const itemId = text(params.itemId);
  switch (method) {
    case "turn/started":
      return [{ t: "turn.started", turnId: text(object(params.turn).id) }];
    case "item/agentMessage/delta":
      return [{ t: "text.delta", turnId, itemId, text: text(params.delta) }];
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return [{ t: "thought.delta", turnId, itemId, text: text(params.delta) }];
    case "item/commandExecution/outputDelta":
      return [{ t: "tool.updated", itemId, output: text(params.delta) }];
    case "turn/plan/updated":
      return [
        {
          t: "plan.updated",
          turnId,
          entries: (Array.isArray(params.plan) ? params.plan : []).map((raw) => {
            const entry = object(raw);
            return {
              step: text(entry.step),
              status:
                entry.status === "inProgress"
                  ? "in_progress"
                  : entry.status === "completed"
                    ? "completed"
                    : "pending",
            };
          }),
        },
      ];
    case "thread/tokenUsage/updated": {
      const tokens = object(params.tokenUsage);
      return [
        { t: "usage.updated", turnId, usage: usage(tokens.last, false, tokens.modelContextWindow) },
        {
          t: "usage.updated",
          usage: {
            ...usage(tokens.total, true, tokens.modelContextWindow),
            contextUsed: number(object(tokens.last).totalTokens),
          },
        },
      ];
    }
    case "turn/completed": {
      const turn = object(params.turn);
      return [
        {
          t: "turn.done",
          turnId: text(turn.id),
          status:
            turn.status === "interrupted"
              ? "interrupted"
              : turn.status === "failed"
                ? "failed"
                : "completed",
        },
      ];
    }
    case "error":
      return [
        {
          t: "status",
          state: params.willRetry ? "reconnecting" : "error",
          detail: "provider_error",
        },
      ];
    case "item/started":
    case "item/completed": {
      const item = object(params.item);
      const itemId = text(item.id);
      const completed = method === "item/completed";
      if (item.type === "contextCompaction")
        return [
          { t: "compaction", state: completed ? "done" : "started", trigger: compactionTrigger },
        ];
      if (item.type === "agentMessage")
        return completed
          ? [
              {
                t: "message.done",
                turnId,
                itemId,
                text: text(item.text),
                phase: item.phase === "commentary" ? "commentary" : "final",
              },
            ]
          : [];
      if (item.type === "reasoning")
        return completed
          ? [
              {
                t: "thought.done",
                turnId,
                itemId,
                text: [
                  ...(Array.isArray(item.summary) ? item.summary.map(text) : []),
                  ...(Array.isArray(item.content) ? item.content.map(text) : []),
                ].join("\n"),
              },
            ]
          : [];
      // Web search returns outside text, so it is a visible tool item (and taints the session).
      if (item.type === "webSearch") {
        const started = {
          t: "tool.started" as const,
          turnId,
          itemId,
          name: "webSearch",
          kind: "search" as const,
          input: { query: text(item.query) },
          title: text(item.query),
        };
        return completed
          ? [started, { t: "tool.done", itemId, status: "ok", output: item.results ?? {} }]
          : [started];
      }
      if (
        !["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(
          text(item.type),
        )
      )
        return [];
      if (!completed)
        return [
          {
            t: "tool.started",
            turnId,
            itemId,
            name:
              item.type === "commandExecution"
                ? "Shell"
                : item.type === "fileChange"
                  ? "Edit"
                  : `${text(item.server)}.${text(item.tool)}`,
            kind:
              item.type === "commandExecution"
                ? "execute"
                : item.type === "fileChange"
                  ? "edit"
                  : "other",
            input:
              item.type === "commandExecution"
                ? { command: item.command, cwd: item.cwd }
                : (item.arguments ?? {}),
          },
        ];
      const diffs = Array.isArray(item.changes)
        ? item.changes.map((raw) => {
            const change = object(raw);
            return { path: text(change.path), patch: text(change.diff) };
          })
        : [];
      return [
        {
          t: "tool.done",
          itemId,
          status:
            item.status === "declined"
              ? "denied"
              : item.status === "failed" ||
                  item.error ||
                  (typeof item.exitCode === "number" && item.exitCode !== 0)
                ? "error"
                : "ok",
          ...(item.type === "commandExecution"
            ? { output: text(item.aggregatedOutput) }
            : { output: item.result ?? item.output ?? item.content ?? {} }),
          ...(diffs.length ? { diffs } : {}),
        },
      ];
    }
    default:
      return [];
  }
}
