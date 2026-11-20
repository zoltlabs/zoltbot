import { randomUUID } from "node:crypto";
import type { AgentSession } from "@zoltbot/adapters-sdk";
import {
  type CommandContext,
  requestNativeCompaction,
  settleNativeCompaction,
} from "@zoltbot/core";
import { commitRuntime, type RuntimeEntry, type SessionManagerOptions } from "./runtime-host.js";

/** What compaction and context reads need from the session manager. */
export interface CompactionHost {
  options: SessionManagerOptions;
  entries: ReadonlyMap<string, RuntimeEntry>;
  failedHandles: Map<string, AgentSession>;
  stopped(): boolean;
  assertMutable(threadId: string): void;
}

/**
 * Asks a live session's provider to compact its context. A repeated command id returns the first
 * result. If the provider may or may not have compacted, the session is closed and the call
 * fails with `compaction_delivery_uncertain`.
 */
export async function performCompact(
  host: CompactionHost,
  sessionId: string,
  instructions: string | undefined,
  commandId: string,
  actor: CommandContext["actor"] = { kind: "human", id: "local-owner" },
): Promise<{ ok: true }> {
  const previous = host.options.store.receipt<Record<string, unknown>>(commandId);
  if (previous) {
    if (previous.result?.kind !== "compact" || previous.result.sessionId !== sessionId)
      throw new Error("command_receipt_conflict");
    const item = host.options.store.snapshot().item?.find((row) => row.id === previous.result.id);
    if ((item?.body as Record<string, unknown> | undefined)?.state === "uncertain")
      throw new Error("compaction_delivery_uncertain");
    return { ok: true };
  }
  if (host.stopped()) throw new Error("runtime_closed");
  const entry = [...host.entries.values()].find((entry) => entry.sessionId === sessionId);
  if (entry) host.assertMutable(String(host.options.store.record("session", sessionId)?.threadId));
  if (!entry) throw new Error("runtime_session_unavailable");
  // A provider refuses to compact mid-turn, and that refusal would read as an uncertain result.
  const busy = host.options.store
    .snapshot()
    .turn?.some((row) => row.sessionId === sessionId && row.status === "running");
  if (busy) throw new Error("session_busy");
  const id = randomUUID(),
    attempt = randomUUID(),
    before = host.options.store.lastSeq();
  let produced = false;
  host.options.store.dispatch(commandId, (state) => {
    produced = true;
    return requestNativeCompaction(state, sessionId, id, attempt, {
      commandId,
      at: new Date().toISOString(),
      actor,
    });
  });
  if (!produced) return { ok: true };
  host.options.publish(host.options.store.eventsSince(before));
  try {
    await entry.native.compact(instructions);
    commitRuntime(host.options, (state, context) =>
      settleNativeCompaction(state, id, attempt, "acknowledged", context),
    );
    void entry.worker.wake();
    return { ok: true };
  } catch {
    const item = host.options.store.snapshot().item?.find((row) => row.id === id);
    if ((item?.body as Record<string, unknown> | undefined)?.state === "completed")
      return { ok: true };
    commitRuntime(host.options, (state, context) =>
      settleNativeCompaction(state, id, attempt, "uncertain", context),
    );
    try {
      await entry.worker.close();
    } catch {
      for (const [threadId, owned] of host.entries)
        if (owned === entry) host.failedHandles.set(threadId, entry.native);
      host.options.onError?.("runtime_cleanup_failed");
    }
    throw new Error("compaction_delivery_uncertain");
  }
}

/**
 * How much of a thread's live session context is used, when its provider reports it. `null` when
 * no session is live or the provider doesn't report a window size.
 */
export async function readContextUsage(
  entries: ReadonlyMap<string, RuntimeEntry>,
  threadId: string,
): Promise<{ used: number; size: number } | null> {
  const entry = entries.get(threadId);
  if (!entry) return null;
  const usage = await entry.native.contextUsage();
  if (!usage?.size) return null;
  return { used: usage.used ?? 0, size: usage.size };
}
