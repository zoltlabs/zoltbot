// M3: once a night, find memory entries that say the same thing and propose one merged entry for
// each pair. Nothing changes until the owner accepts the merge in Needs review.
import { randomUUID } from "node:crypto";
import {
  parseTidyMerge,
  proposeTidyMerge,
  type TidyPair,
  tidyCandidates,
  tidyInstructions,
  tidyPrompt,
} from "@zoltbot/knowledge";
import { type DomainEvent, MEMORY_TIDY_SETTING, memoryTidyOn } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { InferenceAdapter } from "./quick-chat/providers.js";

const actor = { kind: "system" as const, id: "memory-tidy" };
/** The tidy-up runs after this local hour, when the computer is least likely to be in use. */
export const TIDY_HOUR = 3;

export interface TidyHost {
  store: Store;
  publish(events: DomainEvent[]): void;
  router(): Promise<{ adapter: InferenceAdapter; model: string } | undefined>;
  /** True when the text holds a saved secret; such merges are dropped. */
  containsSecret?(text: string): Promise<boolean>;
  now?: () => Date;
  onError?(code: string): void;
}

const localDate = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

async function merge(
  adapter: InferenceAdapter,
  model: string,
  pair: TidyPair,
  signal: AbortSignal,
): Promise<{ title: string; body: string } | undefined> {
  const controller = new AbortController();
  const bounded = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30_000)]);
  let output = "";
  await adapter.stream({
    model,
    conversationId: `memory-tidy-${randomUUID()}`,
    instructions: tidyInstructions,
    turns: [{ role: "user", text: tidyPrompt(pair) }],
    signal: bounded,
    onText(delta) {
      output += delta;
      if (output.length > 8_000) controller.abort(new Error("tidy_output_limit"));
    },
  });
  bounded.throwIfAborted();
  return parseTidyMerge(output);
}

/** A pair the model couldn't merge, or whose merge held a secret, isn't asked again at these revisions. */
const skipId = (pair: TidyPair) => `memory-tidy:skip:${pair.fingerprint}`;

/**
 * One night's pass. Returns the number of merges proposed, or undefined when it did not run
 * (turned off, already done today, or no model is connected; that last case retries later).
 * When every model call fails, the night isn't marked done, so the next check tries again.
 */
export async function runMemoryTidy(host: TidyHost, signal = new AbortController().signal) {
  const at = host.now?.() ?? new Date();
  const doneId = `memory-tidy:${localDate(at)}`;
  if (!memoryTidyOn(host.store.record("settings", MEMORY_TIDY_SETTING)?.value)) return undefined;
  if (host.store.receipt(doneId)) return undefined;
  const pairs = tidyCandidates(host.store.snapshot(["knowledge", "knowledgeProposal"])).filter(
    (pair) => !host.store.receipt(skipId(pair)),
  );
  let proposed = 0;
  let failed = 0;
  if (pairs.length) {
    const connection = await host.router();
    if (!connection) return undefined;
    for (const pair of pairs) {
      if (signal.aborted) return undefined;
      try {
        const merged = await merge(connection.adapter, connection.model, pair, signal);
        if (signal.aborted) return undefined;
        if (!merged || (await host.containsSecret?.(`${merged.title}\n${merged.body}`))) {
          host.store.dispatch(skipId(pair), () => ({ events: [], result: { skipped: true } }));
          continue;
        }
        if (signal.aborted) return undefined;
        const commandId = `${doneId}:${pair.fingerprint}`;
        const before = host.store.lastSeq();
        host.store.dispatch(commandId, (state) =>
          proposeTidyMerge(state, pair, merged, {
            commandId,
            at: (host.now?.() ?? new Date()).toISOString(),
            actor,
          }),
        );
        const events = host.store.eventsSince(before);
        if (events.length) {
          proposed++;
          host.publish(events);
        }
      } catch {
        if (signal.aborted) return undefined;
        failed++;
        host.onError?.("memory_tidy_merge_failed");
      }
    }
  }
  if (failed && failed === pairs.length) return proposed;
  host.store.dispatch(doneId, () => ({ events: [], result: { proposed } }));
  return proposed;
}

/** Checks at start and every 15 minutes, and runs once a local day, after 3 a.m. */
export function memoryTidyTimer(host: TidyHost, intervalMs = 15 * 60 * 1000) {
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (running || controller.signal.aborted) return;
    if ((host.now?.() ?? new Date()).getHours() < TIDY_HOUR) return;
    running = runMemoryTidy(host, controller.signal)
      .catch(() => host.onError?.("memory_tidy_failed"))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const boot = setTimeout(tick, 0);
  boot.unref();
  return {
    tick,
    /** Stops the timer and waits for a run in progress to stop. */
    async close() {
      controller.abort();
      clearTimeout(boot);
      clearInterval(timer);
      await running;
    },
  };
}
