import { hygieneFacts, knowledgeHygiene } from "@zoltbot/knowledge";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

const system = { kind: "system" as const, id: "knowledge-hygiene" };

/** One hygiene pass; the command id is per hour so a restart in the same hour is a no-op. */
export function runKnowledgeHygiene(
  store: Store,
  publish: (events: DomainEvent[]) => void,
  now = new Date(),
) {
  const at = now.toISOString();
  const commandId = `knowledge:hygiene:${at.slice(0, 13)}`;
  const before = store.lastSeq();
  const facts = hygieneFacts(store);
  const result = store.dispatch(commandId, (state) =>
    knowledgeHygiene(state, facts, { commandId, at, actor: system }),
  ).result as { archived: string[]; stale: string[] };
  publish(store.eventsSince(before));
  return result;
}

/** Run hygiene at boot and every six hours. Failures retry on the next tick. */
export function knowledgeHygieneTimer(
  store: Store,
  publish: (events: DomainEvent[]) => void,
  intervalMs = 6 * 60 * 60 * 1000,
) {
  const tick = () => {
    try {
      runKnowledgeHygiene(store, publish);
    } catch {
      // Hygiene only archives or marks stale; a missed pass changes nothing.
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const boot = setTimeout(tick, 0);
  boot.unref();
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
