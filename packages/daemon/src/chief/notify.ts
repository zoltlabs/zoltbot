import { handle } from "@zoltbot/core";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api.js";
import { type ChiefState, chiefThreadId, startedByUser } from "./identity.js";
import { hash, liveThread, refusal, text } from "./tools-model.js";

// The only way Zolt reaches the person from a turn it started itself. Its replies in those
// turns are notes to itself; a notify is a note item in its chat that the Inbox, desktop
// notifications and the phone's Home show.

export const notifyCode = "chief_notify";
export const notifyPrefix = "chief-notify:";
export const notifyLimits = { perDay: 10, length: 600 };

export interface ChiefNotice {
  id: string;
  text: string;
  at: string;
  chatId?: string;
  chatTitle?: string;
}
/** Zolt's notices, newest first. */
export function chiefNotices(state: ChiefState): ChiefNotice[] {
  const chief = chiefThreadId(state);
  return (state.item ?? [])
    .filter(
      (row) =>
        row.threadId === chief &&
        row.kind === "note" &&
        (row.body as { code?: unknown } | undefined)?.code === notifyCode,
    )
    .map((row) => {
      const body = row.body as { text?: unknown; chatId?: unknown; chatTitle?: unknown };
      return {
        id: text(row.id),
        text: text(body.text),
        at: text(row.createdAt),
        ...(text(body.chatId) ? { chatId: text(body.chatId) } : {}),
        ...(text(body.chatTitle) ? { chatTitle: text(body.chatTitle) } : {}),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function notifyTools(
  context: RuntimeContext,
): [string, (call: ToolInvocation) => Promise<unknown>][] {
  return [
    [
      "chief_notify",
      async (call) => {
        const args = call.arguments as { key: string; text: string; chatId?: string };
        // In a conversation the person is reading along; a reply already reaches them.
        if (startedByUser(context.store, call.actor.threadId))
          return refusal("reply_directly", { why: "The user is talking to you; just reply." });
        const message = args.text.trim().slice(0, notifyLimits.length);
        if (!message) return refusal("text_required");
        if (args.chatId && !liveThread(context.store.snapshot(), args.chatId))
          return refusal("chat_not_found");
        const check = await context.privacy.prepareData(message);
        const id = `${notifyPrefix}${hash([call.actor.threadId, args.key]).slice(0, 24)}`;
        const commandId = `chief-notify:${id}`,
          before = context.store.lastSeq();
        const receipt = context.store.dispatch<Record<string, unknown>>(
          commandId,
          (state) => {
            check(state);
            const thread = call.actor.threadId;
            if (state.item?.some((row) => row.id === id)) return { events: [], result: { id } };
            const now = new Date(),
              at = now.toISOString(),
              today = now.toLocaleDateString("en-CA");
            if (
              chiefNotices(state).filter(
                (notice) => new Date(notice.at).toLocaleDateString("en-CA") === today,
              ).length >= notifyLimits.perDay
            )
              return { events: [], result: { error: "daily_limit", why: "Ten a day." } };
            const seq =
              (state.item ?? []).reduce(
                (highest, row) =>
                  row.threadId === thread ? Math.max(highest, Number(row.seq)) : highest,
                0,
              ) + 1;
            const turn = (state.turn ?? []).find(
              (row) => row.threadId === thread && row.status === "running",
            );
            const chat = args.chatId ? liveThread(state, args.chatId) : undefined;
            return {
              ...handle(
                state,
                {
                  type: "create",
                  kind: "item",
                  value: {
                    id,
                    threadId: thread,
                    ...(turn ? { turnId: text(turn.id) } : {}),
                    kind: "note",
                    seq,
                    body: {
                      code: notifyCode,
                      text: message,
                      ...(chat
                        ? { chatId: text(chat.id), chatTitle: text(chat.title) || "Chat" }
                        : {}),
                    },
                    createdAt: at,
                    updatedAt: at,
                  },
                },
                { commandId, at, actor: { kind: "agent", id: call.actor.agentId } },
              ),
              result: { id },
            };
          },
          {
            items: {
              ids: [id],
              latestInThread: call.actor.threadId,
              controlsInThread: call.actor.threadId,
            },
          },
        );
        context.publish(context.store.eventsSince(before));
        if (receipt.result.error) return receipt.result;
        return { ok: true, note: "Delivered to the user's Inbox and notifications." };
      },
    ],
  ];
}
