import { activityFeature } from "@zoltbot/link";
import { activityCounts, type DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { DeviceBook } from "./devices.js";
import type { RelayLink } from "./relay-link.js";

// P3: keeps each phone's Live Activity current through the relay. The frame carries two counts
// and nothing else; the phone shows names from its own cache. The relay drops it for a phone
// that has no activity running, so the Mac needn't know which phones have one.

/** What the Lock Screen shows: agents working, and requests waiting on the owner. */
export const lockScreenCounts = (store: Store) =>
  activityCounts(store.snapshot(["interaction", "task", "settings"]));

export function activityNotifier(options: {
  store: Store;
  devices: DeviceBook;
  link(): RelayLink | undefined;
  delayMs?: number;
  /** How often unchanged counts go out again while something is busy. */
  refreshMs?: number;
}) {
  /** The counts each phone last got, so an unchanged state sends nothing for a while. */
  const sent = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A frame lost to a reconnect, or a phone that started its activity after the last change,
  // catches up on the next refresh.
  const refresh = setInterval(
    () => {
      sent.clear();
      const counts = lockScreenCounts(options.store);
      if (counts.working || counts.needsYou) flush();
    },
    options.refreshMs ?? 5 * 60_000,
  );
  refresh.unref?.();
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    const link = options.link();
    if (link?.status !== "online" || !link.delivers(activityFeature)) {
      sent.clear();
      return;
    }
    const counts = lockScreenCounts(options.store);
    const key = `${counts.working}/${counts.needsYou}/${counts.topId ?? ""}`;
    for (const device of options.devices.paired()) {
      if (sent.get(device.id) === key) continue;
      sent.set(device.id, key);
      link.send({ t: "activity", deviceId: device.id, ...counts });
    }
  }
  return {
    observe(events: readonly DomainEvent[]) {
      if (
        !events.some((event) => ["task", "interaction", "settings"].includes(event.aggregateType))
      )
        return;
      if (timer) return;
      timer = setTimeout(flush, options.delayMs ?? 2000);
      timer.unref?.();
    },
    close() {
      clearInterval(refresh);
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
