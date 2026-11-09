import { handle } from "@zoltbot/core";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api.js";
import { type ChiefState, chiefKeys, setting, settingCommand } from "./identity.js";
import { hash, liveThread, refusal, text } from "./tools-model.js";

// Wake-ups Zolt sets for itself: at a time, or when a chat it is watching finishes.
// The waker reads them as signals and removes each one when it fires.

export interface ChiefTimer {
  id: string;
  /** Zolt's stable key, so setting the same wake-up twice replaces it. */
  key: string;
  reason: string;
  setAt: string;
  /** Fires at this time. */
  at?: string;
  /** Fires when this chat's next turn ends, or when the chat is archived. */
  afterChatId?: string;
}
export const timerLimits = {
  pending: 5,
  minAheadMs: 10 * 60_000,
  maxAheadMs: 7 * 24 * 60 * 60_000,
};

export function chiefTimers(state: ChiefState): ChiefTimer[] {
  const value = setting(state, chiefKeys.timers) as { items?: unknown } | undefined;
  return Array.isArray(value?.items) ? (value.items as ChiefTimer[]) : [];
}
export const timerCommand = (state: ChiefState, items: ChiefTimer[]) =>
  settingCommand(state, chiefKeys.timers, { items });

/** Why a timer is due now, or undefined while it waits. */
export function timerDue(state: ChiefState, timer: ChiefTimer, now: number): string | undefined {
  if (timer.at) return Date.parse(timer.at) <= now ? "the time you set" : undefined;
  const chat = state.thread?.find((row) => row.id === timer.afterChatId);
  if (!chat || chat.archived) return "the chat was archived";
  const ended = (state.turn ?? []).some(
    (row) =>
      row.threadId === timer.afterChatId &&
      row.status !== "running" &&
      Date.parse(text(row.endedAt)) > Date.parse(timer.setAt),
  );
  const running = (state.turn ?? []).some(
    (row) => row.threadId === timer.afterChatId && row.status === "running",
  );
  if (ended && !running) return `"${text(chat.title) || "the chat"}" finished a turn`;
  // A chat that never moves should not hold a slot forever.
  if (now - Date.parse(timer.setAt) > timerLimits.maxAheadMs) return "a week passed";
  return undefined;
}

/** The status block's view of pending wake-ups. */
export function timerLines(state: ChiefState): string[] {
  const timers = chiefTimers(state);
  if (!timers.length) return [];
  const title = (id: string) => text(state.thread?.find((row) => row.id === id)?.title) || id;
  return [
    `Wake-ups you set (${timers.length}; change or cancel with chief_wake_later):`,
    ...timers.map(
      (timer) =>
        `- ${timer.key}: ${timer.at ? `at ${timer.at.slice(0, 16)}Z` : `when "${title(text(timer.afterChatId))}" finishes`}, ${timer.reason}`,
    ),
  ];
}

export function timerTools(
  context: RuntimeContext,
): [string, (call: ToolInvocation) => Promise<unknown>][] {
  return [
    [
      "chief_wake_later",
      async (call) => {
        const args = call.arguments as {
          op: "set" | "cancel";
          key: string;
          reason?: string;
          at?: string;
          afterChatId?: string;
        };
        const now = Date.now();
        const reason = text(args.reason).replace(/\s+/g, " ").trim().slice(0, 200);
        if (args.op === "set") {
          if (!reason) return refusal("reason_required");
          if (!!args.at === !!args.afterChatId) return refusal("set_at_or_afterChatId");
          if (args.at) {
            const at = Date.parse(args.at);
            if (!Number.isFinite(at)) return refusal("invalid_time");
            if (at < now + timerLimits.minAheadMs || at > now + timerLimits.maxAheadMs)
              return refusal("time_out_of_range", {
                why: "Between 10 minutes and 7 days from now.",
              });
          }
          if (args.afterChatId && !liveThread(context.store.snapshot(), args.afterChatId))
            return refusal("chat_not_found");
        }
        const check = await context.privacy.prepareData(reason);
        const commandId = `chief-timer:${hash([args, now])}`,
          before = context.store.lastSeq();
        const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
          check(state);
          const at = new Date(now).toISOString();
          const others = chiefTimers(state).filter((timer) => timer.key !== args.key);
          if (args.op === "cancel" && others.length === chiefTimers(state).length)
            return { events: [], result: { error: "not_found" } };
          if (args.op === "set" && others.length >= timerLimits.pending)
            return { events: [], result: { error: "too_many", why: "Five at a time." } };
          const items =
            args.op === "cancel"
              ? others
              : [
                  ...others,
                  {
                    id: `timer-${hash([call.actor.threadId, args.key]).slice(0, 16)}`,
                    key: args.key,
                    reason,
                    setAt: at,
                    ...(args.at ? { at: new Date(Date.parse(args.at)).toISOString() } : {}),
                    ...(args.afterChatId ? { afterChatId: args.afterChatId } : {}),
                  },
                ];
          return {
            ...handle(state, timerCommand(state, items), {
              commandId,
              at,
              actor: { kind: "agent", id: call.actor.agentId },
            }),
            result: {},
          };
        });
        context.publish(context.store.eventsSince(before));
        if (receipt.result.error) return receipt.result;
        return args.op === "cancel"
          ? { ok: true }
          : {
              ok: true,
              note: "You wake with this reason as a signal. Wake-ups still count against the day's allowance and wait out quiet hours.",
            };
      },
    ],
  ];
}
