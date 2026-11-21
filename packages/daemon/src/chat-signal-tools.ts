// C8: the chat_signal tool. An agent reacts to the owner's message with an emoji instead of
// writing a filler reply ("👀" when it starts, "✅" when it's done).
import { createHash } from "node:crypto";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import { MESSAGE_REACTION_EMOJI } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";
import { writeReaction } from "./message-reactions-api.js";

export const chatSignalToolDefinition = {
  name: "chat_signal",
  description:
    "Signal the person without a reply. react: put an emoji on their latest message in this chat (or on itemId), for example 👀 when you start and ✅ when done. Use it instead of a filler message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["react"] },
      itemId: { type: "string", minLength: 1, maxLength: 256 },
      emoji: { type: "string", enum: [...MESSAGE_REACTION_EMOJI] },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export function chatSignalTools(context: RuntimeContext) {
  return async (call: ToolInvocation) => {
    const args = (call.arguments ?? {}) as { action?: string; itemId?: string; emoji?: string };
    // The compact hint has no schema, so a call without an action is a reaction.
    if ((args.action ?? "react") !== "react") return { error: "unknown_action" };
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
      const key = createHash("sha256").update(call.idempotencyKey).digest("hex").slice(0, 32);
      await writeReaction(context, `chat-signal:${key}`, {
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
