import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { browserApi } from "./browser/api.js";
import { frozenBrowser } from "./browser/evidence.js";
import { taintObserver } from "./knowledge-taint.js";
import type { Logger } from "./logging.js";

/** Fan out committed events and stop browsers owned by finished tasks. */
export function apiObservers({
  companyWatch,
  finish,
  bridges,
  push,
  activity,
  browser,
  store,
  syncRelay,
  logger,
}: {
  companyWatch: { observe(): void };
  finish: { observe(events: DomainEvent[]): void };
  bridges: { observe(events: DomainEvent[]): void };
  push: { observe(events: DomainEvent[]): void };
  activity: { observe(events: DomainEvent[]): void };
  browser: ReturnType<typeof browserApi>;
  store: Store;
  syncRelay(): void;
  logger: Logger;
}) {
  const taint = taintObserver(store);
  return (events: DomainEvent[]) => {
    companyWatch.observe();
    finish.observe(events);
    bridges.observe(events);
    push.observe(events);
    activity.observe(events);
    taint(events);
    browser.observe(events);
    for (const event of events)
      if (
        event.aggregateType === "task" &&
        ["completed", "cancelled"].includes(String((event.payload as { state?: string }).state))
      ) {
        try {
          frozenBrowser(store, event.aggregateId);
          void browser(
            "browser.action",
            {
              id: event.aggregateId,
              action: "stop",
              confirmed: true,
            },
            "task_policy",
          ).catch(() => logger.write("warn", "Owned browser cleanup needs attention"));
        } catch {}
      }
    // Without the Keychain there is no Mac identity, so the link stays off.
    if (
      events.some(
        (event) => event.aggregateId === "link.relayUrl" || event.aggregateType === "device",
      )
    )
      syncRelay();
  };
}
