import { randomUUID } from "node:crypto";
import { applyEvents, type DomainState, handle, queueSystemNotice } from "@zoltbot/core";
import { type DomainEvent, threadFacts } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { type ChiefState, chiefKeys, chiefThreadId, setting, settingCommand } from "./identity.js";
import { chiefProfile, newChiefChat, previousChiefChats } from "./keeper.js";

// chief.clear in two steps. First Zolt gets one turn in its current chat to save a handoff
// (what it is doing, what it promised, what it waits on). When that turn ends, or after
// handoffTimeoutMs, the chat is archived and a fresh one starts with the handoff as its first
// message. Notes, queue, inbox and timers stay throughout.

const system = { kind: "system", id: "chief-clear" } as const;
export const handoffTimeoutMs = 2 * 60_000;
export const handoffLimit = 1500;
/** Item ids of handoff prompts and handoffs, so chats can show them as events. */
export const handoffPrefix = "chief-handoff:";

// "[Zoltbot] " marks these as Zoltbot's notices: chats show the first line as an event.
export const handoffPrompt = [
  "[Zoltbot] Write a handoff for your next chat.",
  "The person is clearing this chat. Call chief_handoff once with what the next chat needs: what you're in the middle of, what you promised the person, and what you're waiting on.",
  `Keep it under ${handoffLimit} characters. Don't reply otherwise.`,
].join("\n");
export const handoffMessage = (text: string) =>
  `[Zoltbot] Handoff from your previous chat:\n${text}\n\nReply in two or three lines with what you're picking up.`;

export interface ChiefClearing {
  commandId: string;
  threadId: string;
  at: string;
}
export interface ChiefHandoff {
  text: string;
  at: string;
  fromThreadId: string;
}
export function chiefClearing(state: ChiefState): ChiefClearing | undefined {
  const value = setting(state, chiefKeys.clearing) as Partial<ChiefClearing> | undefined;
  return value?.commandId && value.threadId && value.at ? (value as ChiefClearing) : undefined;
}
export function chiefHandoff(state: ChiefState): ChiefHandoff | undefined {
  const value = setting(state, chiefKeys.handoff) as Partial<ChiefHandoff> | undefined;
  return value?.text && value.at && value.fromThreadId ? (value as ChiefHandoff) : undefined;
}

/** Whether the handoff step is over: Zolt finished a turn since the prompt, or time ran out. */
export function handoffDone(state: DomainState, clearing: ChiefClearing, now: number): boolean {
  if (now - Date.parse(clearing.at) >= handoffTimeoutMs) return true;
  if (threadFacts(state).working(clearing.threadId)) return false;
  const handoff = chiefHandoff(state);
  if (handoff && handoff.fromThreadId === clearing.threadId && handoff.at >= clearing.at)
    return true;
  return (state.turn ?? []).some(
    (turn) =>
      turn.threadId === clearing.threadId &&
      typeof turn.startedAt === "string" &&
      turn.startedAt >= clearing.at &&
      turn.status !== "running",
  );
}

export function chiefClearApi(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  stopThread(threadId: string, forceCleanup?: boolean): Promise<void> | undefined;
  clearInteractions(threadId: string, commandId: string): Promise<unknown> | undefined;
  wake(threadId: string): Promise<void>;
  now?: () => number;
  pollMs?: number;
  onError?: (code: string) => void;
}) {
  const now = host.now ?? Date.now;
  const kinds = ["settings", "thread", "turn", "agent", "agentDefinition"] as const;
  const read = () => host.store.snapshot([...kinds]);

  function dispatch(
    commandId: string,
    build: (state: DomainState) => { events: DomainEvent[]; result: unknown },
  ) {
    const before = host.store.lastSeq();
    const receipt = host.store.dispatch(commandId, build);
    host.publish(host.store.eventsSince(before));
    return receipt.result;
  }

  /** Archive the old chat, start a fresh one and hand it the handoff, if Zolt wrote one. */
  async function swap(commandId: string, old: string | undefined) {
    if (old) {
      await host.stopThread(old, false);
      await host.clearInteractions(old, `${commandId}:clear`);
    }
    const at = new Date(now()).toISOString();
    const result = dispatch(commandId, (state) => {
      const context = { commandId, at, actor: system };
      const sub = (name: string) => ({ ...context, commandId: `${commandId}:${name}` });
      const events: DomainEvent[] = [];
      let next = state;
      const apply = (produced: DomainEvent[]) => {
        events.push(...produced);
        next = applyEvents(next, produced);
      };
      const current = chiefThreadId(state);
      const row = state.thread?.find((entry) => entry.id === current);
      const agentId = typeof row?.agentId === "string" ? row.agentId : chiefProfile(state);
      if (!agentId) throw new Error("invalid_state: no agent to run Zolt with");
      if (current) {
        apply(
          handle(
            next,
            {
              type: "update",
              kind: "thread",
              id: current,
              changes: { archived: true, archiveWhenIdle: undefined, wakePending: undefined },
            },
            sub("archive"),
          ).events,
        );
        const previous = [current, ...previousChiefChats(next).filter((id) => id !== current)];
        apply(
          handle(next, settingCommand(next, chiefKeys.previous, previous), sub("previous")).events,
        );
      }
      const fresh = newChiefChat(next, context, agentId, randomUUID());
      apply(fresh.events);
      if (chiefClearing(next))
        apply(handle(next, settingCommand(next, chiefKeys.clearing, {}), sub("done")).events);
      const handoff = chiefHandoff(next);
      const handedOff = Boolean(current && handoff?.fromThreadId === current);
      if (handoff && handedOff)
        apply(
          queueSystemNotice(
            next,
            { threadId: fresh.threadId, text: handoffMessage(handoff.text) },
            `${handoffPrefix}${fresh.threadId}`,
            sub("handoff"),
          ).events,
        );
      return {
        events,
        result: { threadId: fresh.threadId, previousThreadId: current, handedOff },
      };
    }) as { threadId: string; handedOff: boolean };
    if (result.handedOff)
      await host.wake(result.threadId).catch(() => host.onError?.("chief_handoff_wake_failed"));
    return result;
  }

  let finishing: Promise<unknown> | undefined;
  /** Finish a clear whose handoff step is over. Safe to call often. */
  function finish() {
    if (finishing) return finishing;
    const state = read();
    const clearing = chiefClearing(state);
    if (!clearing) return undefined;
    if (!handoffDone(state as DomainState, clearing, now())) return undefined;
    finishing = swap(`${clearing.commandId}:finish`, chiefThreadId(state))
      .catch(() => host.onError?.("chief_clear_failed"))
      .finally(() => {
        finishing = undefined;
      });
    return finishing;
  }
  const timer = setInterval(() => void finish(), host.pollMs ?? 2000);
  timer.unref?.();

  async function api(method: string, _params: Record<string, unknown>, commandId?: string) {
    if (method !== "chief.clear") return undefined;
    if (!commandId) throw new Error("command_id_required");
    const replay = host.store.receipt(commandId);
    if (replay) return replay.result;
    const state = read();
    const old = chiefThreadId(state);
    const clearing = chiefClearing(state);
    if (clearing) return { threadId: clearing.threadId, handingOff: true };
    // A chat Zolt never answered in has nothing to hand off.
    if (!old || !(state.turn ?? []).some((turn) => turn.threadId === old))
      return swap(commandId, old);
    if (threadFacts(state as DomainState).working(old))
      throw new Error("invalid_state: Zolt is working. Clear it once it's done.");
    const at = new Date(now()).toISOString();
    const result = dispatch(commandId, (current) => {
      const context = { commandId, at, actor: system };
      const queued = queueSystemNotice(
        current,
        { threadId: old, text: handoffPrompt },
        `${handoffPrefix}${commandId}`,
        { ...context, commandId: `${commandId}:prompt` },
      );
      const next = applyEvents(current, queued.events);
      const value: ChiefClearing = { commandId, threadId: old, at };
      const pointer = handle(next, settingCommand(next, chiefKeys.clearing, value), {
        ...context,
        commandId: `${commandId}:clearing`,
      });
      return {
        events: [...queued.events, ...pointer.events],
        result: { threadId: old, handingOff: true },
      };
    });
    await host.wake(old).catch(() => host.onError?.("chief_handoff_wake_failed"));
    return result;
  }

  return {
    api,
    finish,
    close() {
      clearInterval(timer);
    },
  };
}
