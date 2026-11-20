import { randomUUID } from "node:crypto";
import type { AgentEvent, ContextFullAction, ContextUsage } from "../shared/ipc";
import type { DaemonClient } from "./daemon-client";
import { latestSession, runningTurn, text } from "./mapping";

/** Share of the context window at which a chat compacts itself, when its agent is set to. */
export const AUTO_COMPACT_AT = 0.9;

/** Whether a turn that ended with this much context in use should compact the chat. */
export function shouldAutoCompact(
  usage: ContextUsage | null,
  action: ContextFullAction | undefined,
): boolean {
  return action === "compact" && usage !== null && usage.used / usage.size >= AUTO_COMPACT_AT;
}

/** How full each chat's context is, and compacting it by hand or after a turn. */
export function contextService(
  client: DaemonClient,
  actionFor: (botId: string) => ContextFullAction | undefined,
) {
  async function read(botId: string): Promise<ContextUsage | null> {
    if (client.status !== "online") return null;
    const usage = (await client.call("session.context", { threadId: botId })) as {
      used?: number;
      size?: number;
    };
    return usage.size ? { used: usage.used ?? 0, size: usage.size } : null;
  }
  async function compact(botId: string): Promise<void> {
    const session = latestSession(client.snapshot, botId);
    if (!session) throw new Error("This chat has no session to compact yet.");
    await client.call("session.compact", { id: text(session.id) }, randomUUID());
  }
  const compacting = new Set<string>();
  /** After a turn ends, compacts the chat once if its agent is set to and it is nearly full. */
  async function afterTurn(botId: string, status = "completed"): Promise<boolean> {
    if (status !== "completed" || actionFor(botId) !== "compact" || compacting.has(botId))
      return false;
    // A queued turn may already have started; compacting now would interrupt it.
    if (runningTurn(client.snapshot, botId)) return false;
    compacting.add(botId);
    try {
      if (!shouldAutoCompact(await read(botId), actionFor(botId))) return false;
      if (runningTurn(client.snapshot, botId)) return false;
      await compact(botId);
      return true;
    } catch {
      return false;
    } finally {
      compacting.delete(botId);
    }
  }
  return {
    read,
    compact,
    afterTurn,
    /** Runs `afterTurn` whenever the service reports a finished turn. */
    attach(events: { on(name: "event", listener: (event: AgentEvent) => void): unknown }) {
      events.on("event", (event) => {
        if (event.type === "turn-completed") void afterTurn(event.botId, event.status);
      });
    },
  };
}
