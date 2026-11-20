import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { ContextUsage } from "../../../../shared/ipc";

/** Share of the context window at which the chat offers to compact or start fresh. */
export const CONTEXT_WARN_AT = 0.8;

export function contextPercent(usage: ContextUsage): number {
  return Math.min(100, Math.round((usage.used / usage.size) * 100));
}

export function contextAlmostFull(usage: ContextUsage | null): boolean {
  return usage !== null && usage.used / usage.size >= CONTEXT_WARN_AT;
}

/**
 * How full the chat's context is. Reads it when the chat changes, when a turn in the chat ends
 * and when a compaction lands, so an idle agent isn't woken just to answer; `null` when the agent
 * doesn't report it. `working` says whether a turn runs, since compacting would interrupt it.
 */
export function createContextUsage(botId: () => string | undefined) {
  const [usage, setUsage] = createSignal<ContextUsage | null>(null);
  const [working, setWorking] = createSignal(false);
  let compactions = -1;

  async function reload(id = botId()): Promise<void> {
    if (!id) return;
    try {
      const next = await window.openbot.agent.readContext(id);
      if (botId() === id) setUsage(next);
    } catch {
      if (botId() === id) setUsage(null);
    }
  }

  createEffect(
    on(botId, (id) => {
      setUsage(null);
      setWorking(false);
      compactions = -1;
      void reload(id);
    }),
  );
  const stop = window.openbot.agent.onEvent((event) => {
    if (event.type === "turn-started" && event.botId === botId()) setWorking(true);
    if (event.type === "turn-completed" && event.botId === botId()) {
      setWorking(false);
      void reload();
    }
    if (event.type !== "conversation" || event.snapshot.botId !== botId()) return;
    setWorking(event.snapshot.activeTurnId !== null);
    const count = event.snapshot.messages.filter(
      (message) => message.itemType === "compacted",
    ).length;
    if (compactions >= 0 && count !== compactions) void reload();
    compactions = count;
  });
  onCleanup(stop);

  return {
    usage,
    working,
    reload,
    /** Compacts the chat, then reads how full it is now. */
    async compact(): Promise<void> {
      const id = botId();
      if (!id) return;
      await window.openbot.agent.compact(id);
      await reload(id);
    },
  };
}

export type ContextState = ReturnType<typeof createContextUsage>;
