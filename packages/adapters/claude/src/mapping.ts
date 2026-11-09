import type { AgentEvent, UsageSample } from "@zoltbot/protocol";
import type { ClaudeBackground } from "./background.js";
import {
  agentOutput,
  agentTools,
  interactiveTools,
  toolDiffs,
  toolKind,
  toolLocations,
  toolTitle,
} from "./tools.js";
import { claudeUsage, record, string } from "./usage.js";

interface Message {
  itemId: string;
  text: string;
  parentItemId?: string;
}
export class ClaudeMapper {
  private readonly activeMessages = new Map<string, string>();
  private readonly tools = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly denied = new Set<string>();
  private readonly diffs = new Map<string, { path: string; before?: string; after?: string }[]>();
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly finished = new Set<string>();
  private steered = false;
  /** Per-turn usage of segments a steer ended, added to the final result's sample. */
  private readonly segments: UsageSample[] = [];
  private pending: Message | undefined;
  private terminal = false;
  private interrupted = false;
  private readonly plans = new Map<string, string>();
  private planFile: string | undefined;
  private lastText: string | undefined;
  /** The native user message uuid Claude replayed for this turn's input. */
  userUuid: string | undefined;
  constructor(
    readonly turnId: string,
    private readonly background?: ClaudeBackground,
  ) {}
  // Without a writable plan file, Claude 2.1.316 strips the plan from the ExitPlanMode permission
  // request. Use the plan from the tool call itself, the attempted plan file write, or the latest text.
  planText(toolUseId: string) {
    return this.plans.get(toolUseId) ?? this.planFile ?? this.lastText;
  }
  denyTool(id: string) {
    this.denied.add(id);
  }
  interrupt() {
    this.interrupted = true;
  }
  /**
   * A priority "now" input ends the running segment with an aborted result, and the turn goes on
   * with the steered input, so that result does not end the turn.
   */
  steer() {
    this.steered = true;
  }
  /** Root agent calls still in the foreground, which a steer would cancel. */
  runningAgents() {
    return [...this.calls]
      .filter(
        ([id, call]) =>
          agentTools.includes(call.name) && !this.parents.has(id) && !this.finished.has(id),
      )
      .map(([id]) => id);
  }
  private flush(phase: "commentary" | "final"): AgentEvent[] {
    if (!this.pending) return [];
    const message = this.pending;
    this.pending = undefined;
    return [{ t: "message.done", turnId: this.turnId, ...message, phase }];
  }
  frame(value: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    const parentItemId =
      typeof value.parent_tool_use_id === "string" ? value.parent_tool_use_id : undefined;
    const parent = parentItemId ? { parentItemId } : {};
    const source = parentItemId ?? "root";
    switch (value.type) {
      case "stream_event": {
        const event = record(value.event);
        if (event.type === "message_start") {
          this.activeMessages.set(source, string(record(event.message).id));
          return [];
        }
        if (event.type !== "content_block_delta") return [];
        const delta = record(event.delta),
          itemId = this.activeMessages.get(source) ?? `message-${this.turnId}`;
        if (delta.type === "text_delta")
          return [
            { t: "text.delta", turnId: this.turnId, itemId, ...parent, text: string(delta.text) },
          ];
        if (delta.type === "thinking_delta")
          return [
            {
              t: "thought.delta",
              turnId: this.turnId,
              itemId: `${itemId}:thought`,
              ...parent,
              text: string(delta.thinking),
            },
          ];
        return [];
      }
      case "assistant": {
        const message = record(value.message),
          itemId = string(message.id);
        if (!Array.isArray(message.content)) throw new Error("provider_protocol_error");
        const blocks = message.content.map(record),
          events: AgentEvent[] = [];
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => string(b.text))
          .join("\n");
        const thinking = blocks
          .filter((b) => b.type === "thinking")
          .map((b) => string(b.thinking))
          .join("\n");
        const toolBlocks = blocks.filter((b) => b.type === "tool_use");
        if (thinking)
          events.push({
            t: "thought.done",
            turnId: this.turnId,
            itemId: `${itemId}:thought`,
            ...parent,
            text: thinking,
          });
        if (text && !parentItemId) this.lastText = text;
        if (text) {
          if (parentItemId)
            events.push({
              t: "message.done",
              turnId: this.turnId,
              itemId,
              ...parent,
              text,
              phase: "commentary",
            });
          else {
            if (this.pending && this.pending.itemId !== itemId)
              events.push(...this.flush("commentary"));
            this.pending = { itemId, text };
            if (toolBlocks.length) events.push(...this.flush("commentary"));
          }
        }
        for (const tool of toolBlocks) {
          const toolId = string(tool.id),
            name = string(tool.name);
          if (this.tools.has(toolId)) continue;
          this.tools.add(toolId);
          if (parentItemId) this.parents.set(toolId, parentItemId);
          const input = record(tool.input ?? {});
          if (name === "ExitPlanMode" && typeof input.plan === "string" && input.plan.trim())
            this.plans.set(toolId, input.plan);
          if (
            !parentItemId &&
            name === "Write" &&
            typeof input.file_path === "string" &&
            /[\\/]plans[\\/][^\\/]+\.md$/.test(input.file_path) &&
            typeof input.content === "string" &&
            input.content.trim()
          )
            this.planFile = input.content;
          const diffs = toolDiffs(name, input);
          if (diffs) this.diffs.set(toolId, diffs);
          this.calls.set(toolId, { name, input });
          const title = toolTitle(name, input),
            locations = toolLocations(name, input);
          events.push({
            t: "tool.started",
            turnId: this.turnId,
            itemId: toolId,
            ...parent,
            name,
            kind: toolKind(name),
            input: tool.input ?? {},
            ...(title ? { title } : {}),
            ...(locations ? { locations } : {}),
            ...(interactiveTools.includes(name) ? { interactive: true } : {}),
          });
          if (name === "TodoWrite" && Array.isArray(record(tool.input).todos))
            events.push({
              t: "plan.updated",
              turnId: this.turnId,
              entries: (record(tool.input).todos as unknown[]).map((raw) => {
                const todo = record(raw);
                return {
                  step: string(todo.content),
                  status:
                    todo.status === "completed"
                      ? "completed"
                      : todo.status === "in_progress"
                        ? "in_progress"
                        : "pending",
                };
              }),
            });
        }
        return events;
      }
      case "user": {
        const message = record(value.message);
        const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
        // With --replay-user-messages Claude echoes the turn input with its native uuid,
        // which file checkpoints are keyed by.
        if (
          !parentItemId &&
          typeof value.uuid === "string" &&
          value.uuid &&
          !blocks.some((b) => b.type === "tool_result")
        )
          this.userUuid ??= value.uuid;
        const events: AgentEvent[] = [];
        for (const block of blocks) {
          if (block.type !== "tool_result") continue;
          this.finished.add(string(block.tool_use_id));
          const itemId = string(block.tool_use_id),
            storedParent = parentItemId ?? this.parents.get(itemId),
            call = this.calls.get(itemId);
          const output =
            call && agentTools.includes(call.name) ? agentOutput(block.content) : block.content;
          if (!this.denied.has(itemId) && output !== undefined)
            events.push({
              t: "tool.updated",
              itemId,
              ...(storedParent ? { parentItemId: storedParent } : {}),
              output,
            });
          events.push({
            t: "tool.done",
            itemId,
            ...(storedParent ? { parentItemId: storedParent } : {}),
            status: this.denied.has(itemId) ? "denied" : block.is_error ? "error" : "ok",
            output: output ?? "",
            ...(this.diffs.has(itemId) ? { diffs: this.diffs.get(itemId) ?? [] } : {}),
          });
          if (call?.name === "Bash" && this.background && !block.is_error) {
            const result = value.tool_use_result;
            const structured =
              !!result && typeof result === "object" && "backgroundTaskId" in result;
            if (structured || call.input.run_in_background === true)
              events.push(...this.background.shell(itemId, call.input, block.content, result));
          }
        }
        return events;
      }
      case "system":
        if (value.subtype === "api_retry")
          return [{ t: "status", state: "reconnecting", detail: "provider_retry" }];
        if (value.subtype === "compact_boundary") {
          const metadata = value.compact_metadata ? record(value.compact_metadata) : {};
          return [
            {
              t: "compaction",
              state: "done",
              trigger: metadata.trigger === "manual" ? "manual" : "auto",
              ...(typeof metadata.pre_tokens === "number"
                ? { tokensBefore: metadata.pre_tokens }
                : {}),
            },
          ];
        }
        return [];
      case "result": {
        if (
          this.steered &&
          !this.interrupted &&
          (value.terminal_reason === "aborted_streaming" ||
            value.terminal_reason === "aborted_tools")
        ) {
          const events = this.flush("commentary");
          for (const usage of claudeUsage(value))
            if (usage.cumulative) events.push({ t: "usage.updated", turnId: this.turnId, usage });
            else this.segments.push(usage);
          return events;
        }
        const success = value.subtype === "success" && value.is_error !== true;
        const events = this.flush(success ? "final" : "commentary");
        if (
          success &&
          !events.some((e) => e.t === "message.done") &&
          typeof value.result === "string" &&
          value.result
        )
          events.push({
            t: "message.done",
            turnId: this.turnId,
            itemId: `result-${this.turnId}`,
            text: value.result,
            phase: "final",
          });
        for (const usage of claudeUsage(value))
          events.push({
            t: "usage.updated",
            turnId: this.turnId,
            usage: usage.cumulative ? usage : addSegments(usage, this.segments),
          });
        events.push({
          t: "turn.done",
          turnId: this.turnId,
          status: this.interrupted ? "interrupted" : success ? "completed" : "failed",
        });
        this.terminal = true;
        return events;
      }
      default:
        return [];
    }
  }
}

function addSegments(usage: UsageSample, segments: UsageSample[]): UsageSample {
  const total = { ...usage };
  for (const segment of segments)
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ] as const)
      total[key] = (total[key] ?? 0) + (segment[key] ?? 0);
  return total;
}
