import type {
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { AgentEvent, InteractionDraft } from "@zoltbot/protocol";

export class AcpMapper {
  private readonly denied = new Set<string>();
  private readonly diffs = new Map<string, { path: string; before?: string; after: string }[]>();
  rejectTool(id: string) {
    this.denied.add(id);
  }
  private messages = new Map<string, { text: string; thought: boolean }>();
  context: { used: number; size: number } | undefined;
  constructor(
    readonly turnId: string,
    private readonly compactionTrigger: "auto" | "manual" = "auto",
  ) {}
  update(update: SessionUpdate): AgentEvent[] {
    const turnId = this.turnId;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return [];
        const thought = update.sessionUpdate === "agent_thought_chunk";
        const itemId = `${turnId}:${thought ? "thought" : "message"}:${update.messageId ?? "default"}`;
        const previous = this.messages.get(itemId);
        this.messages.set(itemId, { text: (previous?.text ?? "") + update.content.text, thought });
        return [
          {
            t: thought ? "thought.delta" : "text.delta",
            turnId,
            itemId,
            text: update.content.text,
          },
        ];
      }
      case "tool_call":
        return [
          {
            t: "tool.started",
            turnId,
            itemId: update.toolCallId,
            name: update.name ?? update.title,
            kind: update.kind === "switch_mode" ? "mode" : (update.kind ?? "other"),
            input: update.rawInput ?? {},
            ...(update.locations
              ? {
                  locations: update.locations.map((l) => ({
                    path: l.path,
                    ...(l.line ? { line: l.line } : {}),
                  })),
                }
              : {}),
          },
          ...this.toolUpdate(update),
        ];
      case "tool_call_update":
        return this.toolUpdate(update);
      case "plan":
        return [
          {
            t: "plan.updated",
            turnId,
            entries: update.entries.map((e) => ({ step: e.content, status: e.status })),
          },
        ];
      case "usage_update": {
        this.context = { used: update.used, size: update.size };
        return [
          {
            t: "usage.updated",
            turnId,
            usage: {
              contextUsed: update.used,
              contextSize: update.size,
              ...(update.cost?.currency === "USD" ? { costUsd: update.cost.amount } : {}),
              cumulative: true,
            },
          },
        ];
      }
      case "compaction_update":
        if (!["in_progress", "completed", "failed", "cancelled"].includes(update.status)) return [];
        return [
          {
            t: "compaction",
            state: update.status === "in_progress" ? "started" : "done",
            trigger: this.compactionTrigger,
          },
          ...(update.status === "failed"
            ? [{ t: "status" as const, state: "error" as const, detail: "compaction_failed" }]
            : []),
        ];
      case "notice":
        return [
          {
            t: "status",
            state: update.severity === "error" ? "error" : "ready",
            detail: update.title,
          },
        ];
      default:
        return [];
    }
  }
  private toolUpdate(update: {
    toolCallId: string;
    status?: string | null;
    rawOutput?: unknown;
    content?: ToolCallContent[] | null;
  }): AgentEvent[] {
    const diffs = update.content
      ?.filter((c) => c.type === "diff")
      .map((c) => ({
        path: c.path,
        ...(c.oldText !== null ? { before: c.oldText } : {}),
        after: c.newText,
      }));
    if (diffs?.length) this.diffs.set(update.toolCallId, diffs);
    if (update.status === "completed" || update.status === "failed")
      return [
        {
          t: "tool.done",
          itemId: update.toolCallId,
          status: this.denied.has(update.toolCallId)
            ? "denied"
            : update.status === "completed"
              ? "ok"
              : "error",
          ...(this.diffs.has(update.toolCallId)
            ? { diffs: this.diffs.get(update.toolCallId) ?? [] }
            : {}),
          ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
        },
      ];
    if (update.content || update.rawOutput !== undefined)
      return [
        {
          t: "tool.updated",
          itemId: update.toolCallId,
          ...(update.content ? { content: update.content } : {}),
          ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
        },
      ];
    return [];
  }
  finish(stopReason: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [itemId, message] of this.messages) {
      events.push(
        message.thought
          ? { t: "thought.done", turnId: this.turnId, itemId, text: message.text }
          : { t: "message.done", turnId: this.turnId, itemId, text: message.text, phase: "final" },
      );
    }
    this.messages.clear();
    events.push({
      t: "turn.done",
      turnId: this.turnId,
      status:
        stopReason === "cancelled"
          ? "interrupted"
          : stopReason === "error"
            ? "failed"
            : "completed",
      stopReason,
    });
    return events;
  }
}
export function permissionInteraction(
  request: RequestPermissionRequest,
  ids: { id: string; agentId: string; threadId: string; turnId: string },
): InteractionDraft {
  return {
    ...ids,
    type: "approval",
    title: request.toolCall.title ?? "Tool permission",
    context: {
      toolName: request.toolCall.name ?? request.toolCall.title ?? "Tool",
      toolInput: request.toolCall.rawInput ?? {},
      toolKind:
        request.toolCall.kind === "switch_mode" ? "mode" : (request.toolCall.kind ?? "other"),
      ...(request.toolCall.locations?.length
        ? { paths: request.toolCall.locations.map((location) => location.path) }
        : {}),
    },
    items: [
      {
        id: "permission",
        prompt: request.toolCall.title ?? "Allow this tool?",
        choices: [
          ...(request.options.some((option) => option.kind === "allow_once")
            ? [{ id: "allow_once" as const }]
            : []),
          ...(request.options.some((option) => option.kind === "reject_once")
            ? [{ id: "reject_once" as const }]
            : []),
        ],
        options: request.options.map((o) => ({
          id: o.optionId,
          label: o.name,
          description: o.kind,
        })),
      },
    ],
    chain: [],
    urgency: "blocking",
    nativeRef: ids.id,
  };
}
export function permissionOutcome(
  request: RequestPermissionRequest,
  action: string,
  choice?: string,
): RequestPermissionOutcome {
  const kind = action === "decline" && !choice ? "reject_once" : choice;
  const option =
    kind === "allow_once" || kind === "reject_once"
      ? request.options.find((option) => option.kind === kind)
      : request.options.find((option) => option.optionId === choice);
  if (
    !option ||
    !(
      (action === "accept" && option.kind.startsWith("allow_")) ||
      (action === "decline" && option.kind.startsWith("reject_"))
    )
  )
    return { outcome: "cancelled" };
  return { outcome: "selected", optionId: option.optionId };
}
