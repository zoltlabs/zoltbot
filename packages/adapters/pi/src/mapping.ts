import type { AgentEvent, UsageSample } from "@zoltbot/protocol";
import { record, string } from "./peer.js";

const count = (value: unknown) => {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("provider_protocol_error");
  return Number(value);
};
export function piUsage(value: Record<string, unknown>, cumulative = false): UsageSample {
  const input = count(value.input),
    read = count(value.cacheRead),
    write = count(value.cacheWrite);
  const cost =
    typeof value.cost === "number" ? value.cost : value.cost ? record(value.cost).total : undefined;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0))
    throw new Error("provider_protocol_error");
  return {
    inputTokens: input + read + write,
    outputTokens: count(value.output),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    ...(cost !== undefined ? { costUsd: Number(cost) } : {}),
    cumulative,
  };
}
const kind = (name: string): "execute" | "read" | "edit" | "search" | "other" =>
  ["bash", "powershell"].includes(name)
    ? "execute"
    : name === "read"
      ? "read"
      : ["write", "edit"].includes(name)
        ? "edit"
        : ["grep", "find", "ls"].includes(name)
          ? "search"
          : "other";
export class PiMapper {
  private messageNumber = 0;
  private itemId: string;
  private pending: { itemId: string; text: string } | undefined;
  private readonly diffs = new Map<string, { path: string; before?: string; after?: string }[]>();
  private readonly samples = new Map<string, UsageSample>();
  private terminal = false;
  private failed = false;
  constructor(readonly turnId: string) {
    this.itemId = `message-${turnId}-0`;
  }
  private flush(phase: "commentary" | "final"): AgentEvent[] {
    if (!this.pending) return [];
    const message = this.pending;
    this.pending = undefined;
    return [{ t: "message.done", turnId: this.turnId, ...message, phase }];
  }
  frame(frame: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    const parent =
      typeof frame.parentToolCallId === "string" ? { parentItemId: frame.parentToolCallId } : {};
    switch (frame.type) {
      case "message_start": {
        const message = record(frame.message);
        if (message.role === "assistant")
          this.itemId = `message-${this.turnId}-${++this.messageNumber}`;
        return [];
      }
      case "message_update": {
        const event = record(frame.assistantMessageEvent);
        if (event.type === "text_delta")
          return [
            {
              t: "text.delta",
              turnId: this.turnId,
              itemId: this.itemId,
              text: string(event.delta),
            },
          ];
        if (event.type === "thinking_delta")
          return [
            {
              t: "thought.delta",
              turnId: this.turnId,
              itemId: `${this.itemId}:thought`,
              text: string(event.delta),
            },
          ];
        return [];
      }
      case "message_end": {
        const message = record(frame.message);
        if (message.role !== "assistant") return [];
        if (!Array.isArray(message.content)) throw new Error("provider_protocol_error");
        const blocks = message.content.map(record),
          events: AgentEvent[] = [];
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => string(b.text))
          .join("\n");
        const thought = blocks
          .filter((b) => b.type === "thinking")
          .map((b) => string(b.thinking))
          .join("\n");
        if (thought)
          events.push({
            t: "thought.done",
            turnId: this.turnId,
            itemId: `${this.itemId}:thought`,
            text: thought,
          });
        if (text) {
          events.push(...this.flush("commentary"));
          this.pending = { itemId: this.itemId, text };
          if (blocks.some((b) => b.type === "toolCall")) events.push(...this.flush("commentary"));
        }
        if (message.usage) {
          this.samples.set(this.itemId, piUsage(record(message.usage)));
          const usage: UsageSample = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cumulative: false,
          };
          for (const sample of this.samples.values()) {
            usage.inputTokens = (usage.inputTokens ?? 0) + (sample.inputTokens ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (sample.outputTokens ?? 0);
            usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (sample.cacheReadTokens ?? 0);
            usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (sample.cacheWriteTokens ?? 0);
            if (sample.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + sample.costUsd;
          }
          events.push({ t: "usage.updated", turnId: this.turnId, usage });
        }
        if (message.stopReason === "error") this.failed = true;
        return events;
      }
      case "tool_execution_start": {
        const itemId = string(frame.toolCallId),
          name = string(frame.toolName),
          input = record(frame.args);
        if (
          name === "edit" &&
          typeof input.path === "string" &&
          typeof input.oldText === "string" &&
          typeof input.newText === "string"
        )
          this.diffs.set(itemId, [
            { path: input.path, before: input.oldText, after: input.newText },
          ]);
        if (name === "write" && typeof input.path === "string" && typeof input.content === "string")
          this.diffs.set(itemId, [{ path: input.path, after: input.content }]);
        return [
          {
            t: "tool.started",
            turnId: this.turnId,
            itemId,
            ...parent,
            name,
            kind: kind(name),
            input,
          },
        ];
      }
      case "tool_execution_update":
        return [
          {
            t: "tool.updated",
            itemId: string(frame.toolCallId),
            ...parent,
            output: frame.partialResult ?? {},
          },
        ];
      case "tool_execution_end": {
        const itemId = string(frame.toolCallId),
          result = record(frame.result);
        const denied =
          Array.isArray(result.content) &&
          result.content.some((raw) => {
            const block = record(raw);
            return (
              block.type === "text" &&
              typeof block.text === "string" &&
              block.text.startsWith("ZOLTBOT_DENIED:")
            );
          });
        return [
          {
            t: "tool.done",
            itemId,
            ...parent,
            status: denied ? "denied" : frame.isError ? "error" : "ok",
            output: result,
            ...(this.diffs.has(itemId) ? { diffs: this.diffs.get(itemId) ?? [] } : {}),
          },
        ];
      }
      case "agent_settled":
        this.terminal = true;
        return [
          ...this.flush(frame.aborted || this.failed ? "commentary" : "final"),
          {
            t: "turn.done",
            turnId: this.turnId,
            status: frame.aborted ? "interrupted" : this.failed ? "failed" : "completed",
          },
        ];
      case "auto_retry_start":
        return [{ t: "status", state: "reconnecting", detail: "provider_retry" }];
      case "compaction_start":
      case "auto_compaction_start":
        return [
          {
            t: "compaction",
            state: "started",
            trigger: frame.type === "compaction_start" ? "manual" : "auto",
          },
        ];
      case "compaction_end":
      case "auto_compaction_end":
        if (frame.aborted || typeof frame.errorMessage === "string")
          return [{ t: "status", state: "error", detail: "compaction_aborted_or_failed" }];
        return [
          {
            t: "compaction",
            state: "done",
            trigger: frame.type === "compaction_end" ? "manual" : "auto",
            ...(frame.result && typeof record(frame.result).tokensBefore === "number"
              ? { tokensBefore: Number(record(frame.result).tokensBefore) }
              : {}),
          },
        ];
      default:
        return [];
    }
  }
}
