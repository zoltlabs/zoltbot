// C8: the chat_signal tool. An agent reacts to the owner's message with an emoji instead of
// writing a filler reply ("👀" when it starts, "✅" when it's done).
// C9: status sets the line shown under the chat while the turn runs ("Reading the invoices").
// C10: progress posts a short note at a milestone of a long task.
import { createHash } from "node:crypto";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import { MAX_PROGRESS_LENGTH, MAX_STATUS_LENGTH, MESSAGE_REACTION_EMOJI } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";
import { writeProgressNote } from "./chat-progress.js";
import { writeChatStatus } from "./chat-status.js";
import { writeReaction } from "./message-reactions-api.js";

export const chatSignalToolDefinition = {
  name: "chat_signal",
  description:
    'Signal the person without a reply. react: put an emoji on their latest message in this chat (or on itemId), for example 👀 when you start and ✅ when done. Use it instead of a filler message. status: say in a few words what you\'re doing now ("Reading the invoices"), shown under the chat until the turn ends. progress: on a long task, first say your plan in one sentence, then post a short note at each real milestone, at most one a minute; the person sees each as its own small bubble.',
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["react", "status", "progress"] },
      itemId: { type: "string", minLength: 1, maxLength: 256 },
      emoji: { type: "string", enum: [...MESSAGE_REACTION_EMOJI] },
      status: { type: "string", minLength: 1, maxLength: MAX_STATUS_LENGTH },
      progress: { type: "string", minLength: 1, maxLength: MAX_PROGRESS_LENGTH },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export function chatSignalTools(context: RuntimeContext) {
  return async (call: ToolInvocation) => {
    const args = (call.arguments ?? {}) as {
      action?: string;
      itemId?: string;
      emoji?: string;
      status?: string;
      progress?: string;
    };
    // The compact hint has no schema, so the arguments given pick the action.
    const action =
      args.action ??
      (args.emoji
        ? "react"
        : args.progress !== undefined
          ? "progress"
          : args.status !== undefined
            ? "status"
            : "react");
    const key = () => createHash("sha256").update(call.idempotencyKey).digest("hex").slice(0, 32);
    if (action === "status") {
      if (typeof args.status !== "string") return { error: "status_required" };
      if (!call.actor.turnId) return { error: "turn_required" };
      try {
        await writeChatStatus(context, `chat-status:${key()}`, {
          threadId: call.actor.threadId,
          turnId: call.actor.turnId,
          text: args.status,
        });
        return { ok: true };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (action === "progress") {
      if (typeof args.progress !== "string") return { error: "progress_required" };
      if (!call.actor.turnId) return { error: "turn_required" };
      try {
        await writeProgressNote(context, `chat-progress:${key()}`, {
          threadId: call.actor.threadId,
          turnId: call.actor.turnId,
          text: args.progress,
        });
        return { ok: true };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (action !== "react") return { error: "unknown_action" };
    if (!args.emoji) return { error: "emoji_required" };
    // Agents don't see item ids; by default react to the message that started this turn.
    const latest = context.store
      .latestItems([call.actor.threadId], "user")
      .get(call.actor.threadId);
    const current =
      latest && (!call.actor.turnId || latest.turnId === call.actor.turnId) ? latest : undefined;
    const itemId = args.itemId ?? String(current?.id ?? "");
    if (!itemId) return { error: "message_not_found" };
    try {
      await writeReaction(context, `chat-signal:${key()}`, {
        threadId: call.actor.threadId,
        itemId,
        actor: "agent",
        emoji: args.emoji,
      });
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}
